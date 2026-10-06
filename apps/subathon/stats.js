// Pure helpers: time-zone aware date parsing and aggregation of hourly chat
// buckets into a leaderboard. No I/O in here so it is easy to test.

const HOUR = 3600_000;

// Score used for the default ranking. Raw message count is easy to spam, so
// time spent actually chatting (distinct active hours) counts for more.
export const SCORE_WEIGHTS = { message: 1, hour: 5 };

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    formatters.set(tz, f);
  }
  return f;
}

function parts(ms, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

export function isValidTimeZone(tz) {
  try { formatter(tz); return true; } catch { return false; }
}

export function floorHour(ms) {
  return Math.floor(ms / HOUR) * HOUR;
}

export function dayKey(ms, tz) {
  const p = parts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function hourLabel(ms, tz) {
  const p = parts(ms, tz);
  return `${dayKey(ms, tz)} ${String(p.hour).padStart(2, "0")}:00`;
}

function tzOffsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

export function zonedToUtcMs(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - tzOffsetMs(guess, tz);
  return guess;
}

// Accepts "YYYY-MM-DD" (a whole day in `tz`; as an end bound it includes that
// day), "YYYY-MM-DDTHH:mm" (wall-clock time in `tz`) or a full ISO timestamp
// with Z/offset. Returns epoch ms or null.
export function parseWhen(raw, tz, { end = false } = {}) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return zonedToUtcMs(y, mo, d + (end ? 1 : 0), 0, 0, tz);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(s);
  if (m) return zonedToUtcMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function longestStreak(dayKeys) {
  const nums = [...dayKeys].map((k) => Date.parse(`${k}T00:00:00Z`) / 86400_000).sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  for (const n of nums) {
    run = prev !== null && n - prev === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = n;
  }
  return best;
}

// rows: [{ hour (epoch ms), username, display, messages, words, chars, emotes }]
export function aggregate(rows, { fromMs, toMs, tz }) {
  const users = new Map();
  const timeline = new Map(); // hour ms -> messages
  const dayCache = new Map();
  const dayOf = (ms) => {
    let k = dayCache.get(ms);
    if (!k) { k = dayKey(ms, tz); dayCache.set(ms, k); }
    return k;
  };
  const lo = fromMs == null ? -Infinity : floorHour(fromMs);
  const hi = toMs == null ? Infinity : toMs;
  let total = { messages: 0, words: 0, emotes: 0 };
  let minHour = Infinity, maxHour = -Infinity;

  for (const r of rows) {
    if (r.hour < lo || r.hour >= hi) continue;
    let u = users.get(r.username);
    if (!u) {
      u = { username: r.username, display: r.display || r.username, messages: 0, words: 0, chars: 0, emotes: 0, hours: 0, days: new Set(), first: Infinity, last: -Infinity };
      users.set(r.username, u);
    }
    u.display = r.display || u.display;
    u.messages += r.messages; u.words += r.words; u.chars += r.chars; u.emotes += r.emotes;
    u.hours += 1;
    u.days.add(dayOf(r.hour));
    if (r.hour < u.first) u.first = r.hour;
    if (r.hour > u.last) u.last = r.hour;
    timeline.set(r.hour, (timeline.get(r.hour) || 0) + r.messages);
    total.messages += r.messages; total.words += r.words; total.emotes += r.emotes;
    if (r.hour < minHour) minHour = r.hour;
    if (r.hour > maxHour) maxHour = r.hour;
  }

  const list = [...users.values()].map((u) => ({
    username: u.username,
    display: u.display,
    messages: u.messages,
    words: u.words,
    chars: u.chars,
    emotes: u.emotes,
    avgWords: u.messages ? Math.round((u.words / u.messages) * 10) / 10 : 0,
    activeHours: u.hours,
    activeDays: u.days.size,
    streak: longestStreak(u.days),
    firstSeen: new Date(u.first).toISOString(),
    lastSeen: new Date(u.last).toISOString(),
    score: u.messages * SCORE_WEIGHTS.message + u.hours * SCORE_WEIGHTS.hour
  }));
  list.sort((a, b) => b.score - a.score || b.messages - a.messages || a.username.localeCompare(b.username));

  // Timeline: hourly for short ranges, daily for long ones. Gaps are filled
  // with zeros so offline stretches are visible.
  let points = [];
  let unit = "hour";
  if (timeline.size) {
    unit = (maxHour - minHour) / HOUR > 24 * 7 ? "day" : "hour";
    const buckets = new Map();
    const limit = Math.min(maxHour, minHour + 24 * 366 * HOUR);
    for (let h = minHour; h <= limit; h += HOUR) {
      const label = unit === "hour" ? hourLabel(h, tz) : dayOf(h);
      buckets.set(label, (buckets.get(label) || 0) + (timeline.get(h) || 0));
    }
    points = [...buckets].map(([label, messages]) => ({ label, messages }));
  }

  return {
    totals: { ...total, chatters: list.length },
    chatters: list,
    timeline: { unit, points }
  };
}
