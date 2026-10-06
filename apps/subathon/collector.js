import tmi from "tmi.js";
import { floorHour } from "./stats.js";

const DEFAULT_BOTS = ["nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot", "sery_bot", "soundalerts", "pokemoncommunitygame"];
const ANON_GIFTER = "ananonymousgifter";

export function parseList(raw) {
  return String(raw || "").split(/[,\s]+/).map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
}

// Twitch gives emote positions as code-point ranges ("0-4"), so slice by code
// points, not UTF-16 units, or emoji earlier in the message shift the names.
export function extractEmotes(message, emotesTag) {
  if (!emotesTag) return [];
  const chars = Array.from(String(message));
  const out = [];
  for (const [id, ranges] of Object.entries(emotesTag)) {
    for (const range of Array.isArray(ranges) ? ranges : []) {
      const [from, to] = String(range).split("-").map(Number);
      const name = chars.slice(from, to + 1).join("");
      if (name) out.push({ id, name });
    }
  }
  return out;
}

function merge(map, key, make, add) {
  const cur = map.get(key);
  if (!cur) map.set(key, make());
  else add(cur);
}

// Turns individual chat messages and sub/gift/cheer events into hourly
// counters. Message text is only inspected, never stored.
export function createCollector({ channel, exclude = [], staff = [], countCommands = false, duplicateWindowMs = 10_000, window = null, now = () => Date.now() }) {
  const forcedStaff = new Set(staff);
  const excluded = new Set([...DEFAULT_BOTS, channel, ...exclude]);
  const pending = { chat: new Map(), events: new Map(), emotes: new Map(), watch: new Map() };
  const lastByUser = new Map(); // user -> { text, at }
  const massGiftIds = new Set();
  const stats = { counted: 0, skippedBot: 0, skippedCommand: 0, skippedDuplicate: 0, skippedOutsideWindow: 0 };

  const inWindow = (at) => !window || (at >= window.startMs && at < window.endMs);

  function record({ username, display, text, emotes = 0, emoteList = [], role = "", at = now() }) {
    const user = String(username || "").toLowerCase();
    if (!user) return false;
    if (!inWindow(at)) { stats.skippedOutsideWindow++; return false; }
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
    let b = pending.chat.get(key);
    if (!b) { b = { hour, username: user, display: display || user, role: "", messages: 0, words: 0, chars: 0, emotes: 0 }; pending.chat.set(key, b); }
    b.display = display || b.display;
    b.role = forcedStaff.has(user) ? "mod" : role;
    b.messages += 1;
    b.words += body.split(/\s+/).length;
    b.chars += body.length;
    b.emotes += emotes || emoteList.length;
    for (const e of emoteList) {
      merge(pending.emotes, `${hour}|${e.name}`, () => ({ hour, emote: e.name, emoteId: e.id, count: 1 }), (x) => { x.count += 1; });
    }
    stats.counted++;
    return true;
  }

  // kind: "sub" | "resub" | "gift" (subs gifted) | "bits"
  function recordEvent({ kind, username, display, amount = 1, at = now() }) {
    const user = String(username || "").toLowerCase();
    const n = Math.trunc(Number(amount));
    if (!user || !(n > 0) || !inWindow(at)) return false;
    const hour = floorHour(at);
    merge(pending.events, `${hour}|${kind}|${user}`,
      () => ({ hour, kind, username: user, display: display || user, amount: n }),
      (x) => { x.amount += n; x.display = display || x.display; });
    return true;
  }

  // Seconds a person was connected to chat while the stream was live.
  function recordWatch({ username, display, seconds, at = now() }) {
    const user = String(username || "").toLowerCase();
    const n = Math.round(Number(seconds));
    if (!user || !(n > 0) || !inWindow(at) || excluded.has(user)) return false;
    const hour = floorHour(at);
    merge(pending.watch, `${hour}|${user}`,
      () => ({ hour, username: user, display: display || user, seconds: n }),
      (x) => { x.seconds += n; x.display = display || x.display; });
    return true;
  }

  // A mass gift is announced once ("X gifted 5 subs") and then once more per
  // recipient. Count the announcement and skip the per-recipient events.
  function rememberMassGift(id) {
    if (!id) return;
    massGiftIds.add(String(id));
    if (massGiftIds.size > 500) massGiftIds.delete(massGiftIds.values().next().value);
  }
  const isMassGiftPart = (tags) => Boolean(tags && (tags["msg-param-community-gift-id"] || massGiftIds.has(String(tags["msg-param-origin-id"]))));

  function drain() {
    const out = { chat: [...pending.chat.values()], events: [...pending.events.values()], emotes: [...pending.emotes.values()], watch: [...pending.watch.values()] };
    pending.chat.clear(); pending.events.clear(); pending.emotes.clear(); pending.watch.clear();
    return out;
  }

  function requeue(batch) {
    for (const r of batch.chat || []) {
      merge(pending.chat, `${r.hour}|${r.username}`, () => r, (b) => {
        b.role = r.role || b.role; b.messages += r.messages; b.words += r.words; b.chars += r.chars; b.emotes += r.emotes;
      });
    }
    for (const r of batch.events || []) merge(pending.events, `${r.hour}|${r.kind}|${r.username}`, () => r, (b) => { b.amount += r.amount; });
    for (const r of batch.emotes || []) merge(pending.emotes, `${r.hour}|${r.emote}`, () => r, (b) => { b.count += r.count; });
    for (const r of batch.watch || []) merge(pending.watch, `${r.hour}|${r.username}`, () => r, (b) => { b.seconds += r.seconds; });
  }

  return { record, recordEvent, recordWatch, rememberMassGift, isMassGiftPart, drain, requeue, stats, inWindow, peek: () => ({ chat: [...pending.chat.values()], events: [...pending.events.values()], emotes: [...pending.emotes.values()], watch: [...pending.watch.values()] }) };
}

// Moderators and VIPs carry a badge on every message they send.
function roleOf(tags) {
  if (tags.mod || tags.badges?.moderator) return "mod";
  if (tags.badges?.vip) return "vip";
  return "";
}

// Anonymous, read-only Twitch IRC connection: no account or OAuth needed.
// Subs, gifts and cheers are announced to every chat client, so they are
// tracked from here too.
export function connectChat({ channel, collector, sevenTv = null, onRoomId = () => {}, onStatus = () => {} }) {
  const client = new tmi.Client({ connection: { reconnect: true, secure: true }, channels: [channel] });
  const who = (tags, fallback) => ({ username: (tags?.login || fallback || "").toLowerCase(), display: tags?.["display-name"] || fallback });

  client.on("connected", () => onStatus(true));
  client.on("disconnected", () => onStatus(false));
  client.on("roomstate", (_c, state) => {
    const id = state?.["room-id"];
    if (!id) return;
    sevenTv?.start(id);
    onRoomId(id);
  });

  client.on("message", (_chan, tags, message, self) => {
    if (self || tags["message-type"] === "whisper") return;
    const emoteList = extractEmotes(message, tags.emotes);
    if (sevenTv) emoteList.push(...sevenTv.match(message, new Set(emoteList.map((e) => e.name))));
    collector.record({ username: tags.username, display: tags["display-name"], text: message, emoteList, role: roleOf(tags) });
  });

  client.on("subscription", (_c, username, _m, _msg, tags) => collector.recordEvent({ kind: "sub", ...who(tags, username) }));
  client.on("resub", (_c, username, _streak, _msg, tags) => collector.recordEvent({ kind: "resub", ...who(tags, username) }));
  client.on("subgift", (_c, username, _streak, _recipient, _m, tags) => {
    if (collector.isMassGiftPart(tags)) return;
    collector.recordEvent({ kind: "gift", ...who(tags, username) });
  });
  client.on("submysterygift", (_c, username, count, _m, tags) => {
    collector.rememberMassGift(tags?.["msg-param-origin-id"]);
    collector.recordEvent({ kind: "gift", ...who(tags, username), amount: count });
  });
  client.on("anonsubgift", (_c, _streak, _recipient, _m, tags) => {
    if (collector.isMassGiftPart(tags)) return;
    collector.recordEvent({ kind: "gift", username: "ananonymousgifter", display: "Anonymous" });
  });
  client.on("anonsubmysterygift", (_c, count, _m, tags) => {
    collector.rememberMassGift(tags?.["msg-param-origin-id"]);
    collector.recordEvent({ kind: "gift", username: "ananonymousgifter", display: "Anonymous", amount: count });
  });
  client.on("cheer", (_c, tags) => collector.recordEvent({ kind: "bits", username: tags.username, display: tags["display-name"], amount: tags.bits }));

  client.connect().catch((error) => console.error("subathon: Twitch chat connection failed.", error));
  return client;
}
