import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { aggregate, aggregateEmotes, aggregateEvents, floorHour, isValidTimeZone, parseWhen } from "./stats.js";
import { createCollector, connectChat, parseList } from "./collector.js";
import { createStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNEL_RE = /^[a-z0-9_]{2,25}$/;
const FLUSH_MS = 5000;
const MAX_ROWS = 2000;
// The event this page is for. Chat outside the window is neither recorded nor shown.
// Override with SUBATHON_START / SUBATHON_END ("YYYY-MM-DDTHH:mm", in SUBATHON_TZ).
const DEFAULT_START = "2026-10-11T15:00";
const DEFAULT_END = "2026-10-25T22:00";

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Private chat-activity tracker for a subathon. Not linked from the public
// index, protected by SUBATHON_PASSWORD on every request, and entirely
// disabled (404) unless both SUBATHON_PASSWORD and SUBATHON_CHANNEL are set.
export function createSubathonApp() {
  const router = express.Router();
  const password = process.env.SUBATHON_PASSWORD || "";
  const channel = String(process.env.SUBATHON_CHANNEL || "").trim().toLowerCase().replace(/^#/, "");

  if (!password || !CHANNEL_RE.test(channel)) {
    if (password || channel) console.warn("subathon: disabled — set both SUBATHON_PASSWORD and a valid SUBATHON_CHANNEL.");
    router.use((_req, res) => res.status(404).end());
    return router;
  }

  const tz = isValidTimeZone(process.env.SUBATHON_TZ || "") ? process.env.SUBATHON_TZ : "Europe/Copenhagen";
  const startText = parseWhen(process.env.SUBATHON_START, tz) != null ? process.env.SUBATHON_START.trim() : DEFAULT_START;
  const endText = parseWhen(process.env.SUBATHON_END, tz) != null ? process.env.SUBATHON_END.trim() : DEFAULT_END;
  const win = { startMs: parseWhen(startText, tz), endMs: parseWhen(endText, tz) };
  const store = createStore({ channel, databaseUrl: process.env.DATABASE_URL });
  const collector = createCollector({
    channel,
    exclude: parseList(process.env.SUBATHON_EXCLUDE),
    staff: parseList(process.env.SUBATHON_STAFF),
    window: win,
    countCommands: process.env.SUBATHON_COUNT_COMMANDS === "1"
  });
  const state = { connected: false, startedAt: new Date().toISOString(), lastFlushAt: null, lastFlushError: null };

  const ready = store.init().catch((error) => {
    console.error("subathon: database init failed.", error);
    state.lastFlushError = String(error.message || error);
  });
  if (!store.persistent) console.warn("subathon: no DATABASE_URL — chat counts are kept in memory and lost on restart.");

  async function flush() {
    await ready;
    const batch = collector.drain();
    if (!batch.chat.length && !batch.events.length && !batch.emotes.length) return;
    try {
      await store.addChat(batch.chat);
      await store.addEvents(batch.events);
      await store.addEmotes(batch.emotes);
      state.lastFlushAt = new Date().toISOString();
      state.lastFlushError = null;
    } catch (error) {
      collector.requeue(batch);
      state.lastFlushError = String(error.message || error);
      console.error("subathon: failed to save chat counts, will retry.", error);
    }
  }
  setInterval(flush, FLUSH_MS).unref();
  for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => { flush().finally(() => process.exit(0)); });

  connectChat({ channel, collector, onStatus: (ok) => { state.connected = ok; } });

  router.use((_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

  function requireAuth(req, res, next) {
    if (!safeEqual(req.headers["x-subathon-key"] || "", password)) return res.status(401).json({ error: "Wrong password" });
    next();
  }

  const windowInfo = { start: startText, end: endText, startMs: win.startMs, endMs: win.endMs };

  async function compute(query) {
    let fromMs = query.from ? parseWhen(query.from, tz) : win.startMs;
    let toMs = query.to ? parseWhen(query.to, tz, { end: true }) : win.endMs;
    if (fromMs == null || toMs == null) return { error: "Invalid date" };
    // Always stay inside the subathon window.
    fromMs = Math.max(fromMs, win.startMs);
    toMs = Math.min(toMs, win.endMs);
    await flush();
    const nowMs = Date.now();
    const [chatRows, eventRows, emoteRows] = await Promise.all([
      store.chatRows(floorHour(fromMs), toMs),
      store.eventRows(floorHour(fromMs), toMs),
      store.emoteRows(floorHour(fromMs), toMs)
    ]);
    const result = aggregate(chatRows, { fromMs, toMs, tz });
    const events = aggregateEvents(eventRows, { fromMs, toMs, tz, nowMs });
    const emotes = aggregateEmotes(emoteRows, { fromMs, toMs });
    return { fromMs, toMs, result, events, emotes };
  }

  router.get("/api/status", requireAuth, (_req, res) => {
    res.json({
      channel, tz,
      window: windowInfo,
      connected: state.connected,
      persistent: store.persistent,
      startedAt: state.startedAt,
      lastFlushAt: state.lastFlushAt,
      lastFlushError: state.lastFlushError,
      skipped: collector.stats
    });
  });

  router.get("/api/stats", requireAuth, async (req, res) => {
    try {
      const out = await compute(req.query);
      if (out.error) return res.status(400).json({ error: out.error });
      const { result, events } = out;
      const roles = new Map(result.staff.map((c) => [c.username, c.role]));
      const tagRole = (list) => list.slice(0, 100).map((c) => ({ ...c, role: roles.get(c.username) || "" }));
      res.json({
        channel, tz,
        window: windowInfo,
        from: out.fromMs == null ? null : new Date(out.fromMs).toISOString(),
        to: out.toMs == null ? null : new Date(out.toMs).toISOString(),
        totals: result.totals,
        busiest: result.busiest,
        overview: { subs: events.subs, bits: events.bits, today: events.today, bestDay: events.bestDay, avgPerDay: events.avgPerDay, days: events.days },
        gifters: tagRole(events.gifters),
        cheerers: tagRole(events.cheerers),
        emotes: out.emotes,
        timeline: result.timeline,
        truncated: result.chatters.length > MAX_ROWS,
        chatters: result.chatters.slice(0, MAX_ROWS),
        staff: result.staff.slice(0, MAX_ROWS)
      });
    } catch (error) {
      console.error("subathon: stats failed.", error);
      res.status(500).json({ error: "Could not load stats" });
    }
  });

  router.get("/api/export.csv", requireAuth, async (req, res) => {
    try {
      const out = await compute(req.query);
      if (out.error) return res.status(400).json({ error: out.error });
      const esc = (v) => {
        let s = String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running usernames as formulas
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const cols = ["rank", "role", "username", "display", "score", "messages", "activeHours", "activeDays", "streak", "words", "avgWords", "emotes", "firstSeen", "lastSeen"];
      const lines = [cols.join(",")];
      const line = (rank, c) => [rank, ...cols.slice(1).map((k) => c[k])].map(esc).join(",");
      out.result.chatters.forEach((c, i) => lines.push(line(i + 1, { ...c, role: "viewer" })));
      out.result.staff.forEach((c, i) => lines.push(line(i + 1, c))); // ranked within their own bracket
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${channel}-chat-stats.csv"`);
      res.send(lines.join("\n"));
    } catch (error) {
      console.error("subathon: export failed.", error);
      res.status(500).json({ error: "Could not export" });
    }
  });

  return router;
}
