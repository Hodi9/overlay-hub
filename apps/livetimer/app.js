import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { adjust, applyStatus, cleanChannel, cleanSettings, logChannel, MAX_ELAPSED_MS, parseDuration, pause, recordError, reset, restore, setElapsed, setEnabled } from "./logic.js";
import { createStatusChecker } from "./twitchStatus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Live-timer: tæller op mens en Twitch-kanal er live og står stille mens den er offline. Overlayet ligger på
// /livetimer/ og panelet på /livetimer/control.html. Serveren tjekker kanalen hvert halve minut (pollMs).
// Tests sender deres egen checkStatus og pollMs: 0 (ingen automatisk tjek) og now.
export function createLiveTimerApp({ pool = null, checkStatus = null, pollMs = 30000, now = () => Date.now() } = {}) {
  const router = express.Router();
  const controlPassword = process.env.LIVETIMER_CONTROL_PASSWORD || "";
  const checker = checkStatus ? { check: checkStatus, source: "test" } : createStatusChecker();
  let state = restore({ channel: process.env.LIVETIMER_CHANNEL || undefined });
  let db = pool;
  let checking = null;
  const listeners = new Set();

  const requireAuth = (req, res, next) => {
    if (!controlPassword || safeEqual(req.headers["x-livetimer-key"] || "", controlPassword)) return next();
    res.status(401).json({ error: "Forkert eller manglende adgangskode." });
  };

  const ready = (async () => {
    if (!db) return;
    await db.query(`CREATE TABLE IF NOT EXISTS livetimer_state (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const { rows } = await db.query("SELECT data FROM livetimer_state WHERE id = 'primary'");
    if (rows[0]) state = restore(rows[0].data);
  })().catch((error) => {
    console.error("livetimer: database unavailable; using in-memory state.", error);
    db = null;
  });

  const payload = () => ({ ...state, serverNow: new Date(now()).toISOString(), source: checker.source, passwordRequired: Boolean(controlPassword) });

  function commit(next) {
    const changed = JSON.stringify({ ...next, lastCheckAt: null }) !== JSON.stringify({ ...state, lastCheckAt: null });
    state = next;
    // Only real changes are saved; a check that changes nothing but the time of the check is just broadcast.
    if (changed) {
      db?.query(
        `INSERT INTO livetimer_state (id, data, updated_at) VALUES ('primary', $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [JSON.stringify(state)]
      ).catch((error) => console.error("livetimer: could not save state.", error));
    }
    const message = `data: ${JSON.stringify(payload())}\n\n`;
    for (const response of listeners) response.write(message);
    return payload();
  }

  // One check at a time; a check that fails leaves the timer as it is (a network hiccup is not "offline").
  function checkNow() {
    if (checking) return checking;
    const channel = state.channel;
    checking = (async () => {
      try {
        const status = await checker.check(channel);
        if (channel === state.channel) commit(applyStatus(state, status, now()));
      } catch (error) {
        commit(recordError(state, error.message || "Tjek fejlede.", now()));
      } finally {
        checking = null;
      }
      return payload();
    })();
    return checking;
  }

  let timer = null;
  if (pollMs > 0) {
    ready.then(() => {
      checkNow();
      timer = setInterval(checkNow, pollMs);
      timer.unref?.();
    });
  }

  router.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    ready.then(() => next(), next);
  });
  router.use(express.json({ limit: "4kb" }));

  router.get("/api/state", (_req, res) => res.json(payload()));

  router.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.flushHeaders();
    listeners.add(res);
    res.write(`data: ${JSON.stringify(payload())}\n\n`);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20000);
    req.on("close", () => {
      clearInterval(keepAlive);
      listeners.delete(res);
    });
  });

  router.post("/api/login", requireAuth, (_req, res) => res.json({ ok: true }));

  router.post("/api/check", requireAuth, async (_req, res) => res.json(await checkNow()));

  router.patch("/api/settings", requireAuth, async (req, res) => {
    let next = cleanSettings(req.body, state);
    if (typeof req.body?.enabled === "boolean") next = setEnabled(next, req.body.enabled, now());
    if (req.body?.channel !== undefined) {
      const channel = cleanChannel(req.body.channel);
      if (!channel) return res.status(400).json({ error: "Det ligner ikke et Twitch-navn." });
      if (channel !== next.channel) {
        // A new channel pauses the timer (time already counted stays) until the new channel is seen live.
        next = logChannel({ ...pause(next, now()), channel, live: false, lastSeenLiveAt: null, lastError: null }, channel, now());
      }
    }
    const result = commit(next);
    if (req.body?.channel !== undefined || req.body?.enabled === true) return res.json(await checkNow());
    res.json(result);
  });

  router.post("/api/reset", requireAuth, (_req, res) => res.json(commit(reset(state, now()))));

  // Correct the time: { elapsedMs } or { time: "1:02:03" } sets it, { deltaMs } moves it up or down.
  router.post("/api/correct", requireAuth, (req, res) => {
    const body = req.body || {};
    if (Number.isFinite(body.deltaMs)) {
      if (Math.abs(body.deltaMs) > MAX_ELAPSED_MS) return res.status(400).json({ error: "Det er for meget på én gang." });
      return res.json(commit(adjust(state, body.deltaMs, now())));
    }
    const target = Number.isFinite(body.elapsedMs) ? body.elapsedMs : parseDuration(body.time);
    if (target === null || !Number.isFinite(target) || target < 0 || target > MAX_ELAPSED_MS) {
      return res.status(400).json({ error: "Skriv tiden som t:mm:ss, fx 12:34:56 (eller 2d 3:04:05)." });
    }
    res.json(commit(setElapsed(state, target, now())));
  });

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    console.error("livetimer:", error);
    res.status(error.status || 500).json({ error: "Timeren kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) console.log("ADVARSEL: LIVETIMER_CONTROL_PASSWORD er ikke sat — live-timer-panelet er ubeskyttet for alle med linket.");

  router.close = () => clearInterval(timer);
  return router;
}
