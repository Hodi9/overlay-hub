import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE = {
  label: "BREAKING",
  headline: "MOON TV LIVE FRA BEGIVENHEDERNES CENTRUM",
  station: "MOON TV",
  ticker: [
    "Seneste nyt: Vi følger udviklingen tæt",
    "Direkte opdateringer hele aftenen",
    "Ring til redaktionen på 91 68 23 67"
  ],
  speed: 34,
  color: "#ef233c",
  dark: "#9f1023",
  showClock: true,
  paused: false
};

const PALETTES = new Map([
  ["#ef233c", "#9f1023"],
  ["#1769e0", "#0a387f"],
  ["#f0a202", "#9c5f00"],
  ["#00a896", "#00675d"]
]);

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function cleanText(value, fallback, max) {
  const text = String(value ?? "").trim().slice(0, max);
  return text || fallback;
}

function cleanState(input, current = DEFAULT_STATE) {
  const color = PALETTES.has(input?.color) ? input.color : current.color;
  const ticker = Array.isArray(input?.ticker)
    ? input.ticker.map((item) => String(item).trim().slice(0, 120)).filter(Boolean).slice(0, 12)
    : current.ticker;
  return {
    label: cleanText(input?.label, current.label, 24),
    headline: cleanText(input?.headline, current.headline, 68),
    station: cleanText(input?.station, current.station, 16),
    ticker: ticker.length ? ticker : current.ticker,
    speed: [24, 34, 44].includes(Number(input?.speed)) ? Number(input.speed) : current.speed,
    color,
    dark: PALETTES.get(color) || current.dark,
    showClock: typeof input?.showClock === "boolean" ? input.showClock : current.showClock,
    paused: typeof input?.paused === "boolean" ? input.paused : current.paused
  };
}

export function createMoonTvApp() {
  const router = express.Router();
  const controlPassword = process.env.MOONTV_CONTROL_PASSWORD || "";
  const listeners = new Set();
  let state = { ...DEFAULT_STATE };
  let db = null;

  function authorized(request) {
    if (!controlPassword) return false;
    return safeEqual(request.headers["x-moontv-key"] || "", controlPassword);
  }

  function requireAuth(request, response, next) {
    if (authorized(request)) return next();
    if (!controlPassword) return response.status(503).json({ error: "Kontrolpanelets adgangskode er ikke konfigureret." });
    return response.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  function payload() {
    return { ...state, updatedAt: new Date().toISOString() };
  }

  function broadcast() {
    const message = `data: ${JSON.stringify(payload())}\n\n`;
    for (const response of listeners) response.write(message);
  }

  async function persist() {
    if (!db) return;
    await db.query(
      `INSERT INTO moontv_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      ["primary", JSON.stringify(state)]
    );
  }

  async function connectDatabase() {
    if (!process.env.DATABASE_URL) return;
    const { Pool } = pg;
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });
    await db.query(`
      CREATE TABLE IF NOT EXISTS moontv_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await db.query("SELECT data FROM moontv_state WHERE id = $1", ["primary"]);
    if (result.rows[0]?.data) state = cleanState(result.rows[0].data, state);
    else await persist();
  }

  router.use(express.json({ limit: "24kb" }));

  router.get("/api/state", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(payload());
  });

  router.get("/api/events", (request, response) => {
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.flushHeaders();
    listeners.add(response);
    response.write(`data: ${JSON.stringify(payload())}\n\n`);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20000);
    request.on("close", () => {
      clearInterval(keepAlive);
      listeners.delete(response);
    });
  });

  router.post("/api/auth", requireAuth, (_request, response) => response.json({ ok: true }));

  router.put("/api/state", requireAuth, async (request, response, next) => {
    try {
      state = cleanState(request.body, state);
      await persist();
      broadcast();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "Moon TV-indstillingerne kunne ikke gemmes." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) console.log("ADVARSEL: MOONTV_CONTROL_PASSWORD er ikke sat — Moon TV-kontrolpanelet er låst.");
  connectDatabase().catch((error) => console.error("Moon TV database connection failed; using in-memory state.", error));

  return router;
}
