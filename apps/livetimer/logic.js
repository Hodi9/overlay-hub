// Live-timer: a stopwatch that runs while a Twitch channel is live and pauses while it is offline.
// Time adds up across streams (and across a stream that drops and comes back) until the panel resets it.
//
// State:
//   accumulatedMs  time already counted in earlier, finished stretches
//   liveSince      ISO time the current stretch started counting, or null while paused
//   lastSeenLiveAt ISO time of the latest check that saw the channel live
//   countedUntil   ISO time nothing before which may be counted again (set by stops, resets and pauses),
//                  so a stream that flickers offline and back is not counted twice
//   log            newest-first list of what happened: { at, type, elapsedMs, fromMs?, channel? }
//                  types: start, stop, auto-off, auto-on, channel, reset, correct

export const ACCENTS = ["lime", "mint", "blue", "violet", "yellow", "pink", "white", "orange"];
const CHANNEL_RE = /^[a-z0-9_]{2,25}$/;

export const DEFAULT_STATE = {
  channel: "wendelbolol",
  enabled: true,
  label: "Live for",
  accent: "lime",
  accumulatedMs: 0,
  liveSince: null,
  lastSeenLiveAt: null,
  countedUntil: null,
  live: false,
  lastCheckAt: null,
  lastError: null,
  log: []
};

export const LOG_LIMIT = 50;
export const MAX_ELAPSED_MS = 1000 * 86400000; // 1000 days: anything above is a typo

function addLog(state, entry) {
  const clean = { at: entry.at, type: entry.type, elapsedMs: Math.max(0, Math.round(entry.elapsedMs)) };
  if (Number.isFinite(entry.fromMs)) clean.fromMs = Math.max(0, Math.round(entry.fromMs));
  if (entry.channel) clean.channel = entry.channel;
  return { ...state, log: [clean, ...(state.log || [])].slice(0, LOG_LIMIT) };
}

export function cleanChannel(value) {
  const cleaned = String(value ?? "").trim().toLowerCase().replace(/^.*twitch\.tv\//, "").replace(/[/?#].*$/, "").replace(/^@/, "");
  return CHANNEL_RE.test(cleaned) ? cleaned : null;
}

const iso = (ms) => new Date(ms).toISOString();
const ms = (value) => (value ? Date.parse(value) : NaN);

// decapi.me/twitch/uptime answers "OFFLINE" (our offline_msg) or e.g. "1 day, 2 hours, 5 minutes, 3 seconds".
// Returns the uptime in ms, 0 for a stream that just started ("0 seconds"), null when offline;
// throws on anything else (unknown user, rate limit text, an error page).
export function parseDecapiUptime(text) {
  const body = String(text ?? "").trim();
  if (/^offline$/i.test(body) || /is offline$/i.test(body)) return null;
  const units = { day: 86400000, hour: 3600000, minute: 60000, second: 1000 };
  let total = 0;
  let found = false;
  for (const match of body.matchAll(/(\d+)\s+(day|hour|minute|second)s?\b/gi)) {
    total += Number(match[1]) * units[match[2].toLowerCase()];
    found = true;
  }
  if (!found) throw new Error(`Uventet svar fra decapi: ${body.slice(0, 80)}`);
  return total;
}

function closeStretch(state, endMs) {
  if (!state.liveSince) return state;
  const start = ms(state.liveSince);
  const end = Math.max(start, endMs);
  return { ...state, accumulatedMs: state.accumulatedMs + (end - start), liveSince: null, countedUntil: iso(end) };
}

// Applies one check of the channel. status = { live, startedAt (ISO or null) }; nowMs = the time of the check.
export function applyStatus(state, status, nowMs) {
  const next = { ...state, live: Boolean(status.live), lastCheckAt: iso(nowMs), lastError: null };
  if (!status.live) {
    // Stops at the last moment we saw it live, so a long gap between checks is not counted.
    if (!state.liveSince) return next;
    const stopped = closeStretch(next, ms(state.lastSeenLiveAt) || nowMs);
    return addLog(stopped, { at: stopped.countedUntil, type: "stop", elapsedMs: stopped.accumulatedMs, channel: state.channel });
  }
  next.lastSeenLiveAt = iso(nowMs);
  if (!state.enabled || state.liveSince) return next;
  // Start counting from when the stream started, but never before what is already counted or before a reset.
  const startedAt = ms(status.startedAt);
  let start = Number.isFinite(startedAt) && startedAt <= nowMs ? startedAt : nowMs;
  const floor = ms(state.countedUntil);
  if (Number.isFinite(floor)) start = Math.max(start, Math.min(floor, nowMs));
  next.liveSince = iso(start);
  return addLog(next, { at: next.liveSince, type: "start", elapsedMs: next.accumulatedMs, channel: next.channel });
}

export function recordError(state, message, nowMs) {
  return { ...state, lastCheckAt: iso(nowMs), lastError: String(message).slice(0, 200) };
}

export function elapsedMs(state, nowMs) {
  return state.accumulatedMs + (state.liveSince ? Math.max(0, nowMs - ms(state.liveSince)) : 0);
}

// Back to 0:00:00. If the channel is live right now the timer keeps running from 0.
export function reset(state, nowMs) {
  const before = elapsedMs(state, nowMs);
  const next = { ...state, accumulatedMs: 0, liveSince: state.liveSince ? iso(nowMs) : null, countedUntil: iso(nowMs) };
  return addLog(next, { at: iso(nowMs), type: "reset", elapsedMs: 0, fromMs: before });
}

// Sets the timer to an exact time (a correction). A running timer keeps running from the new time.
export function setElapsed(state, targetMs, nowMs) {
  const target = Math.min(MAX_ELAPSED_MS, Math.max(0, Math.round(Number(targetMs) || 0)));
  const before = elapsedMs(state, nowMs);
  const next = { ...state, accumulatedMs: target, liveSince: state.liveSince ? iso(nowMs) : null };
  return addLog(next, { at: iso(nowMs), type: "correct", elapsedMs: target, fromMs: before });
}

// Moves the timer up or down by deltaMs (never below 0).
export function adjust(state, deltaMs, nowMs) {
  return setElapsed(state, elapsedMs(state, nowMs) + Number(deltaMs || 0), nowMs);
}

// "1:02:03", "26:00:00", "2d 3:04:05" (days + t:mm:ss) or "12:30" (hours:minutes) → ms; null if it can't be read.
export function parseDuration(text) {
  const body = String(text ?? "").trim().toLowerCase();
  const m = body.match(/^(?:(\d+)\s*(?:d|dag|dage|day|days)\s*)?(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const [, d = 0, h, mi, se = 0] = m;
  if (Number(mi) > 59 || Number(se) > 59) return null;
  return ((Number(d) * 24 + Number(h)) * 3600 + Number(mi) * 60 + Number(se)) * 1000;
}

// Stops a running stretch now (the time stays counted); the next check that sees the channel live starts a new one.
export function pause(state, nowMs) {
  return { ...closeStretch(state, nowMs), countedUntil: iso(nowMs) };
}

// Turning the automatic start off pauses a running timer; turning it on starts it at the next check that sees the channel live.
export function setEnabled(state, enabled, nowMs) {
  if (enabled === state.enabled) return state;
  const next = { ...pause(state, nowMs), enabled };
  return addLog(next, { at: iso(nowMs), type: enabled ? "auto-on" : "auto-off", elapsedMs: next.accumulatedMs });
}

export function cleanSettings(input, state) {
  const next = { ...state };
  if (typeof input?.label === "string") next.label = input.label.trim().slice(0, 30);
  if (ACCENTS.includes(input?.accent)) next.accent = input.accent;
  return next;
}

export function restore(saved) {
  const merged = { ...DEFAULT_STATE, ...(saved && typeof saved === "object" ? saved : {}) };
  merged.channel = cleanChannel(merged.channel) || DEFAULT_STATE.channel;
  merged.accumulatedMs = Number.isFinite(merged.accumulatedMs) && merged.accumulatedMs >= 0 ? merged.accumulatedMs : 0;
  merged.enabled = merged.enabled !== false;
  if (!ACCENTS.includes(merged.accent)) merged.accent = DEFAULT_STATE.accent;
  merged.log = (Array.isArray(merged.log) ? merged.log : [])
    .filter((e) => e && typeof e === "object" && typeof e.type === "string" && Number.isFinite(Date.parse(e.at)) && Number.isFinite(e.elapsedMs))
    .slice(0, LOG_LIMIT);
  return merged;
}

// Logs that the panel switched channel (the app pauses first).
export function logChannel(state, channel, nowMs) {
  return addLog(state, { at: iso(nowMs), type: "channel", elapsedMs: elapsedMs(state, nowMs), channel });
}
