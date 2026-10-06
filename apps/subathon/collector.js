import tmi from "tmi.js";
import { floorHour } from "./stats.js";

const DEFAULT_BOTS = ["nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot", "sery_bot", "soundalerts", "pokemoncommunitygame"];

export function parseList(raw) {
  return String(raw || "").split(/[,\s]+/).map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
}

// Turns individual chat messages into hourly per-user counters. Message text
// is only inspected, never stored.
export function createCollector({ channel, exclude = [], staff = [], countCommands = false, duplicateWindowMs = 10_000, now = () => Date.now() }) {
  const forcedStaff = new Set(staff);
  const excluded = new Set([...DEFAULT_BOTS, channel, ...exclude]);
  const pending = new Map(); // "hour|user" -> bucket
  const lastByUser = new Map(); // user -> { text, at }
  const stats = { counted: 0, skippedBot: 0, skippedCommand: 0, skippedDuplicate: 0 };

  function record({ username, display, text, emotes = 0, role = "", at = now() }) {
    const user = String(username || "").toLowerCase();
    if (!user) return false;
    if (excluded.has(user)) { stats.skippedBot++; return false; }
    const body = String(text || "").trim();
    if (!body) return false;
    if (!countCommands && body.startsWith("!")) { stats.skippedCommand++; return false; }

    const prev = lastByUser.get(user);
    if (prev && prev.text === body && at - prev.at < duplicateWindowMs) { stats.skippedDuplicate++; return false; }
    lastByUser.set(user, { text: body, at });
    if (lastByUser.size > 5000) {
      for (const [k, v] of lastByUser) if (at - v.at > duplicateWindowMs) lastByUser.delete(k);
    }

    const hour = floorHour(at);
    const key = `${hour}|${user}`;
    let b = pending.get(key);
    if (!b) { b = { hour, username: user, display: display || user, role: "", messages: 0, words: 0, chars: 0, emotes: 0 }; pending.set(key, b); }
    b.display = display || b.display;
    b.role = forcedStaff.has(user) ? "mod" : role;
    b.messages += 1;
    b.words += body.split(/\s+/).length;
    b.chars += body.length;
    b.emotes += emotes;
    stats.counted++;
    return true;
  }

  function drain() {
    const rows = [...pending.values()];
    pending.clear();
    return rows;
  }

  function requeue(rows) {
    for (const r of rows) {
      const key = `${r.hour}|${r.username}`;
      const b = pending.get(key);
      if (!b) { pending.set(key, r); continue; }
      b.role = r.role || b.role;
      b.messages += r.messages; b.words += r.words; b.chars += r.chars; b.emotes += r.emotes;
    }
  }

  return { record, drain, requeue, stats, peek: () => [...pending.values()] };
}

// Moderators and VIPs carry a badge on every message they send.
function roleOf(tags) {
  if (tags.mod || tags.badges?.moderator) return "mod";
  if (tags.badges?.vip) return "vip";
  return "";
}

function countEmotes(emotes) {
  if (!emotes) return 0;
  let n = 0;
  for (const ranges of Object.values(emotes)) n += Array.isArray(ranges) ? ranges.length : 0;
  return n;
}

// Anonymous, read-only Twitch IRC connection: no account or OAuth needed.
export function connectChat({ channel, collector, onStatus = () => {} }) {
  const client = new tmi.Client({ connection: { reconnect: true, secure: true }, channels: [channel] });
  client.on("connected", () => onStatus(true));
  client.on("disconnected", () => onStatus(false));
  client.on("message", (_chan, tags, message, self) => {
    if (self || tags["message-type"] === "whisper") return;
    collector.record({ username: tags.username, display: tags["display-name"], text: message, emotes: countEmotes(tags.emotes), role: roleOf(tags) });
  });
  client.connect().catch((error) => console.error("subathon: Twitch chat connection failed.", error));
  return client;
}
