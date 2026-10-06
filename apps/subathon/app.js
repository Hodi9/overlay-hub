import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { aggregate, aggregateEmotes, aggregateEvents, floorHour, isValidTimeZone, parseWhen } from "./stats.js";
import { createCollector, connectChat, parseList } from "./collector.js";
import { createStore } from "./store.js";
import { createSevenTv } from "./sevenTv.js";
import { createWatchtime } from "./watch.js";

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
export function createSubathonApp({ mountPath = "" } = {}) {
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
    if (!batch.chat.length && !batch.events.length && !batch.emotes.length && !batch.watch.length) return;
    try {
      await store.addChat(batch.chat);
      await store.addEvents(batch.events);
      await store.addEmotes(batch.emotes);
      await store.addWatch(batch.watch);
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

  const sevenTv = createSevenTv();
  const watch = createWatchtime({
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    store,
    onPresent: (p) => collector.recordWatch(p)
  });
  ready.then(() => watch.init());
  connectChat({ channel, collector, sevenTv, onRoomId: (id) => watch.start(id), onStatus: (ok) => { state.connected = ok; } });

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
    const [chatRows, eventRows, emoteRows, watchRows] = await Promise.all([
      store.chatRows(floorHour(fromMs), toMs),
      store.eventRows(floorHour(fromMs), toMs),
      store.emoteRows(floorHour(fromMs), toMs),
      store.watchRows(floorHour(fromMs), toMs)
    ]);
    const result = aggregate(chatRows, { fromMs, toMs, tz, watchRows, staffNames: new Set(parseList(process.env.SUBATHON_STAFF)) });
    const events = aggregateEvents(eventRows, { fromMs, toMs, tz, nowMs });
    const emotes = aggregateEmotes(emoteRows, { fromMs, toMs });
    return { fromMs, toMs, result, events, emotes };
  }

  // Where Twitch sends people back after they approve. Must match the
  // redirect URL registered in the Twitch app exactly.
  function redirectUri(req) {
    const base = (process.env.SUBATHON_PUBLIC_URL || "").trim().replace(/\/+$/, "")
      || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.headers.host}`;
    return `${base}${mountPath}/auth/callback`;
  }

  router.post("/api/twitch/link", requireAuth, (req, res) => {
    if (!watch.enabled) return res.status(400).json({ error: "Watchtime is not set up (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET missing)." });
    const uri = redirectUri(req);
    res.json({ url: watch.connectUrl(uri), redirectUri: uri });
  });

  router.get("/auth/callback", async (req, res) => {
    const page = (title, text) => res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;background:#f4eee3;color:#221c15;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:24px">${title}</h1><p>${text}</p></main>`);
    if (req.query.error) return page("Ikke forbundet", "Forbindelsen blev afbrudt. Du kan lukke fanen og prøve igen med et nyt link.");
    try {
      await watch.handleCallback({ code: req.query.code, state: req.query.state, redirectUri: redirectUri(req) });
      page("Forbundet ✓", "Tak! Watchtime bliver nu målt, mens streamen er live. Du kan lukke fanen.");
    } catch (error) {
      console.error("subathon: Twitch connect failed.", error.message);
      page("Det lykkedes ikke", String(error.message || "Prøv igen med et nyt link.").replace(/[<>&]/g, ""));
    }
  });

  router.get("/api/status", requireAuth, (req, res) => {
    res.json({
      channel, tz,
      window: windowInfo,
      connected: state.connected,
      persistent: store.persistent,
      startedAt: state.startedAt,
      lastFlushAt: state.lastFlushAt,
      lastFlushError: state.lastFlushError,
      sevenTv: sevenTv.status,
      watch: { ...watch.status, redirectUri: watch.enabled ? redirectUri(req) : null },
      skipped: collector.stats
    });
  });

  router.get("/api/stats", requireAuth, async (req, res) => {
    try {
      const out = await compute(req.query);
      if (out.error) return res.status(400).json({ error: out.error });
      const { result, events } = out;
      const roles = new Map(result.staff.map((c) => [c.username, c.role]));
      const tagRole = (list) => list.slice(0, 10).map((c) => ({ ...c, role: roles.get(c.username) || "" }));
      res.json({
        channel, tz,
        window: windowInfo,
        from: out.fromMs == null ? null : new Date(out.fromMs).toISOString(),
        to: out.toMs == null ? null : new Date(out.toMs).toISOString(),
        watch: { enabled: watch.enabled, connected: watch.status.connected, live: watch.status.live },
        totals: result.totals,
        busiest: result.busiest,
        overview: { subs: events.subs, bits: events.bits, today: events.today, bestDay: events.bestDay, avgPerDay: events.avgPerDay, days: events.days },
        gifters: tagRole(events.gifters),
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
      const cols = ["rank", "role", "username", "display", "score", "messages", "watchSeconds", "activeHours", "activeDays", "streak", "words", "avgWords", "emotes", "firstSeen", "lastSeen"];
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
