import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { DEFAULT_STATE, applyPatch, effectiveState } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// "Gå gennem Danmark"-overlay + kontrolpanel. Skjult: ikke på forsiden, og kun
// monteret når WALK_PATH er sat til en hemmelig sti (se server.js). Panelet
// kræver WALK_CONTROL_PASSWORD; er den ikke sat, er panelet låst (ingen ændringer).
export function createWalkApp() {
  const router = express.Router();
  const controlPassword = process.env.WALK_CONTROL_PASSWORD || "";
  let state = { ...DEFAULT_STATE };
  let db = null;
  const fails = new Map(); // ip -> { count, resetAt }

  function clientIp(req) {
    return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  }

  function requireControlAuth(req, res, next) {
    if (!controlPassword) return res.status(503).json({ error: "WALK_CONTROL_PASSWORD er ikke sat på serveren — panelet er låst." });
    const ip = clientIp(req);
    const rec = fails.get(ip);
    if (rec && rec.resetAt > Date.now() && rec.count >= MAX_FAILS) {
      return res.status(429).json({ error: "For mange forkerte forsøg. Vent et par minutter." });
    }
    if (safeEqual(String(req.headers["x-walk-key"] || ""), controlPassword)) {
      fails.delete(ip);
      return next();
    }
    const fresh = rec && rec.resetAt > Date.now() ? rec : { count: 0, resetAt: Date.now() + FAIL_WINDOW_MS };
    fresh.count += 1;
    fails.set(ip, fresh);
    return res.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  async function connectDatabase() {
    if (!process.env.DATABASE_URL) return;
    db = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });
    await db.query(`CREATE TABLE IF NOT EXISTS walk_state (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const { rows } = await db.query("SELECT data FROM walk_state WHERE id = 'primary'");
    if (rows[0]) state = applyPatch({ ...DEFAULT_STATE, kmDate: rows[0].data.kmDate ?? null }, rows[0].data);
  }

  function persist() {
    if (!db) return;
    db.query(
      `INSERT INTO walk_state (id, data) VALUES ('primary', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify(state)]
    ).catch((error) => console.error("walk: could not save state.", error));
  }

  router.use((_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(express.json({ limit: "4kb" }));

  // Offentlig (overlayet læser den): kun det der skal vises.
  router.get("/api/state", (_req, res) => res.json({ ...effectiveState(state), passwordSet: Boolean(controlPassword) }));

  // Panelet bruger den til at tjekke koden, før den gemmes.
  router.post("/api/login", requireControlAuth, (_req, res) => res.json({ ok: true }));

  router.post("/api/state", requireControlAuth, (req, res) => {
    state = applyPatch(state, req.body || {});
    persist();
    res.json({ ...effectiveState(state), passwordSet: true });
  });

  router.use(express.static(path.join(__dirname, "public"), { index: "index.html", extensions: ["html"] }));

  if (!controlPassword) console.log("ADVARSEL: WALK_CONTROL_PASSWORD er ikke sat — walk-panelet er låst.");
  connectDatabase().catch((error) => console.error("walk: database connection failed; using in-memory state.", error));

  return router;
}
