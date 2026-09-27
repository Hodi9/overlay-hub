import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_TABLE = "rdr2_deaths_state";

// Phrases the OCR tracker's captured text is checked against (normalized:
// lowercased, accents stripped, punctuation collapsed to spaces). Kept as a
// plain list so it's easy to extend once we see real captures from the
// control panel's "last capture" debug line.
const DEATH_PHRASES = [
  "you have been killed",
  "you were killed",
  "you have died",
  "you are dead",
  "you died"
].map(normalize);

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function createRdr2DeathsApp() {
  const router = express.Router();
  const controlPassword = process.env.RDR2DEATHS_CONTROL_PASSWORD || "";
  const trackerKey = process.env.RDR2DEATHS_TRACKER_KEY || "";

  let db = null;
  const state = { count: 0, lastDeathAt: null, lastCapture: null };
  let deathScreenActive = false;
  const listeners = new Set();

  async function connectDatabase() {
    if (!process.env.DATABASE_URL) return;
    const { Pool } = pg;
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${DB_TABLE} (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await db.query(`SELECT data FROM ${DB_TABLE} WHERE id = 'primary'`);
    const saved = result.rows[0]?.data;
    if (saved && Number.isFinite(saved.count)) {
      state.count = Math.max(0, Math.trunc(saved.count));
      state.lastDeathAt = saved.lastDeathAt || null;
    }
  }

  const ready = connectDatabase().catch((error) => {
    console.error("rdr2-deaths database connection failed; using in-memory state.", error);
  });

  async function persist() {
    if (!db) return;
    await db.query(
      `INSERT INTO ${DB_TABLE} (id, data, updated_at)
       VALUES ('primary', $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify({ count: state.count, lastDeathAt: state.lastDeathAt })]
    );
  }

  function payload() {
    return {
      count: state.count,
      lastDeathAt: state.lastDeathAt,
      lastCapture: state.lastCapture,
      passwordRequired: Boolean(controlPassword),
      trackerConfigured: Boolean(trackerKey),
      updatedAt: new Date().toISOString()
    };
  }

  function broadcast() {
    const message = `data: ${JSON.stringify(payload())}\n\n`;
    for (const response of listeners) response.write(message);
  }

  async function commit() {
    await persist();
    broadcast();
  }

  function authorizedControl(request) {
    if (!controlPassword) return true;
    const key = String(request.headers["x-rdr2deaths-key"] || "");
    return safeEqual(key, controlPassword);
  }

  function requireControlAuth(request, response, next) {
    if (authorizedControl(request)) return next();
    return response.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  function authorizedTracker(request) {
    if (!trackerKey) return false;
    const header = String(request.headers.authorization || "");
    return safeEqual(header, `Bearer ${trackerKey}`);
  }

  router.use(express.json({ limit: "16kb" }));

  router.get("/api/state", async (_request, response) => {
    await ready;
    response.set("Cache-Control", "no-store");
    response.json(payload());
  });

  router.get("/api/events", async (request, response) => {
    await ready;
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

  // Called by the local OCR tracker script with whatever text it read from
  // the death-screen region. Edge-detected: the death text stays on screen
  // for several ticks, so we only increment the moment it first appears and
  // arm again once a tick reads something else (the player has respawned).
  router.post("/api/tracker", async (request, response) => {
    if (!authorizedTracker(request)) return response.status(401).json({ error: "Unauthorized" });
    await ready;

    const text = typeof request.body?.text === "string" ? request.body.text.slice(0, 300) : "";
    const normalized = normalize(text);
    const matched = Boolean(normalized) && DEATH_PHRASES.some((phrase) => normalized.includes(phrase));
    state.lastCapture = { text, matched, atISO: new Date().toISOString() };

    let incremented = false;
    if (matched && !deathScreenActive) {
      deathScreenActive = true;
      state.count += 1;
      state.lastDeathAt = new Date().toISOString();
      incremented = true;
      await commit();
    } else {
      if (!matched) deathScreenActive = false;
      broadcast();
    }

    response.json({ ok: true, matched, incremented, count: state.count });
  });

  router.post("/api/increment", requireControlAuth, async (_request, response) => {
    await ready;
    state.count += 1;
    state.lastDeathAt = new Date().toISOString();
    await commit();
    response.json(payload());
  });

  router.post("/api/decrement", requireControlAuth, async (_request, response) => {
    await ready;
    state.count = Math.max(0, state.count - 1);
    await commit();
    response.json(payload());
  });

  router.post("/api/state", requireControlAuth, async (request, response) => {
    await ready;
    const value = Number(request.body?.count);
    if (!Number.isFinite(value) || value < 0) {
      return response.status(400).json({ error: "count skal være et positivt tal." });
    }
    state.count = Math.trunc(value);
    await commit();
    response.json(payload());
  });

  router.post("/api/reset", requireControlAuth, async (_request, response) => {
    await ready;
    state.count = 0;
    state.lastDeathAt = null;
    deathScreenActive = false;
    await commit();
    response.json(payload());
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "rdr2-deaths-servicen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) {
    console.log("ADVARSEL: RDR2DEATHS_CONTROL_PASSWORD er ikke sat — panelet er ubeskyttet for alle med linket.");
  }
  if (!trackerKey) {
    console.log("ADVARSEL: RDR2DEATHS_TRACKER_KEY er ikke sat — den automatiske tracker kan ikke sende opdateringer.");
  }

  return router;
}
