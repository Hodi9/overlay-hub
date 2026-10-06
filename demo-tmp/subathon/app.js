import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { aggregate, floorHour, isValidTimeZone, parseWhen } from "./stats.js";
import { createCollector, connectChat, parseList } from "./collector.js";
import { createStore } from "./store.js";


const NAMES=["PixelPanda","nightowl_92","CozyCactus","lunarlex","TurboToast","mellow_moose","GlitterGoblin","bytebandit","sunnyside_up","ramenrider","QuietStorm","frostfox"];
function seedRows(){let s=7;const r=()=>(s=(s*16807)%2147483647)/2147483647;const out=[];const start=Math.floor(Date.now()/3600e3)*3600e3-47*3600e3;
for(let h=0;h<48;h++){if(h%24<6||h%24>20)continue;NAMES.concat(["BigMod_Ben:mod","VIPLuna:vip"]).forEach((n,i)=>{if(r()>0.8-i*0.03)return;const[nm,role=""]=n.split(":");const m=Math.max(1,Math.round(r()*(20-i)+2));out.push({hour:start+h*3600e3,username:nm.toLowerCase(),display:nm,role,messages:m,words:m*4,chars:m*20,emotes:Math.round(m*r()*.6)})})}return out}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNEL_RE = /^[a-z0-9_]{2,25}$/;
const FLUSH_MS = 5000;
const MAX_ROWS = 2000;

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
  const store = createStore({ channel, databaseUrl: process.env.DATABASE_URL });
  const collector = createCollector({
    channel,
    exclude: parseList(process.env.SUBATHON_EXCLUDE),
    staff: parseList(process.env.SUBATHON_STAFF),
    countCommands: process.env.SUBATHON_COUNT_COMMANDS === "1"
  });
  const state = { connected: false, startedAt: new Date().toISOString(), lastFlushAt: null, lastFlushError: null };

  const ready = store.init().catch((error) => {
    console.error("subathon: database init failed.", error);
    state.lastFlushError = String(error.message || error);
  });
  ready.then(() => store.add(seedRows()));
  if (!store.persistent) console.warn("subathon: no DATABASE_URL — chat counts are kept in memory and lost on restart.");

  async function flush() {
    await ready;
    const rows = collector.drain();
    if (!rows.length) return;
    try {
      await store.add(rows);
      state.lastFlushAt = new Date().toISOString();
      state.lastFlushError = null;
    } catch (error) {
      collector.requeue(rows);
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

  async function compute(query) {
    const fromMs = parseWhen(query.from, tz);
    const toMs = parseWhen(query.to, tz, { end: true });
    if ((query.from && fromMs == null) || (query.to && toMs == null)) return { error: "Invalid date" };
    await flush();
    const rows = await store.rows(fromMs == null ? null : floorHour(fromMs), toMs);
    const result = aggregate(rows, { fromMs, toMs, tz });
    return { fromMs, toMs, result };
  }

  router.get("/api/status", requireAuth, (_req, res) => {
    res.json({
      channel, tz,
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
      const { result } = out;
      res.json({
        channel, tz,
        from: out.fromMs == null ? null : new Date(out.fromMs).toISOString(),
        to: out.toMs == null ? null : new Date(out.toMs).toISOString(),
        totals: result.totals,
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
