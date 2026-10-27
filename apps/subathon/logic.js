import crypto from "node:crypto";

// Everything the subathon does with numbers lives here, with the clock passed in, so the
// timer, the gift matching and the goals can be tested without a server or a Twitch chat.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

export const LIMITS = {
  secondsPerSub: 24 * 60 * 60,
  timerSeconds: 30 * 24 * 60 * 60,
  goals: 30,
  events: 50,
  count: 1_000_000
};

// A tier 2 sub pays twice and a tier 3 sub five times what tier 1 does, so the defaults follow that.
export const DEFAULT_SETTINGS = {
  secondsPerSub: { t1: 20, t2: 40, t3: 100 },
  maxSeconds: 0, // 0 = the timer may grow without limit
  startSeconds: 60 * 60
};

const newId = () => crypto.randomBytes(5).toString("hex");

function seconds(raw, label, fallback, max) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (raw === null || raw === "" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new ValidationError(`${label} skal være et tal mellem 0 og ${max}.`);
  }
  return Math.round(value);
}

/** Checks a settings object from the panel; fields that are left out keep their value from `base`. */
export function cleanSettings(input, base = DEFAULT_SETTINGS) {
  const source = input && typeof input === "object" ? input : {};
  const per = source.secondsPerSub && typeof source.secondsPerSub === "object" ? source.secondsPerSub : {};
  const settings = {
    secondsPerSub: {
      t1: seconds(per.t1, "Sekunder pr. Tier 1-sub", base.secondsPerSub.t1, LIMITS.secondsPerSub),
      t2: seconds(per.t2, "Sekunder pr. Tier 2-sub", base.secondsPerSub.t2, LIMITS.secondsPerSub),
      t3: seconds(per.t3, "Sekunder pr. Tier 3-sub", base.secondsPerSub.t3, LIMITS.secondsPerSub)
    },
    maxSeconds: seconds(source.maxSeconds, "Maks. tid", base.maxSeconds, LIMITS.timerSeconds),
    startSeconds: seconds(source.startSeconds, "Starttid", base.startSeconds, LIMITS.timerSeconds)
  };
  if (settings.maxSeconds > 0 && settings.startSeconds > settings.maxSeconds) {
    throw new ValidationError("Starttiden kan ikke være længere end maks. tiden.");
  }
  return settings;
}

export const secondsForTier = (settings, tier) => settings.secondsPerSub[`t${tier}`] ?? settings.secondsPerSub.t1;

// ---- goals ------------------------------------------------------------------------------

const sortGoals = (goals) => goals.slice().sort((a, b) => a.target - b.target);

/** Checks the goal list from the panel and returns it sorted by target. Ids are kept, or made when missing. */
export function cleanGoals(input) {
  if (!Array.isArray(input)) throw new ValidationError("Målene skal være en liste.");
  if (input.length > LIMITS.goals) throw new ValidationError(`Der kan højst være ${LIMITS.goals} mål.`);
  const used = new Set();
  const goals = input.map((raw) => {
    const title = String(raw?.title ?? "").trim().slice(0, 60);
    const target = Number(raw?.target);
    if (!title) throw new ValidationError("Hvert mål skal have en titel.");
    if (!Number.isInteger(target) || target < 1 || target > LIMITS.count) {
      throw new ValidationError(`Målet "${title}" skal have et helt antal subs mellem 1 og ${LIMITS.count}.`);
    }
    let id = typeof raw?.id === "string" && /^[a-z0-9]{4,24}$/.test(raw.id) && !used.has(raw.id) ? raw.id : newId();
    while (used.has(id)) id = newId();
    used.add(id);
    return { id, title, target };
  });
  return sortGoals(goals);
}

/** The goals with a `reached` flag, and the first one that is still ahead of the count. */
export function goalProgress(goals, count) {
  const list = goals.map((goal) => ({ ...goal, reached: count >= goal.target }));
  return { goals: list, next: list.find((goal) => !goal.reached) || null };
}

// ---- timer ------------------------------------------------------------------------------
// A timer is { status, remainingMs, anchor, addedMs }. While it runs, `remainingMs` is what was
// left at the moment `anchor` (epoch ms); at any other time it is exact and `anchor` is null.
// Nothing ticks on the server: the time left is worked out from the clock whenever it is asked for,
// which is also why a running timer carries on correctly after a restart.

export const createTimer = (remainingMs = 0) => ({ status: "idle", remainingMs, anchor: null, addedMs: 0 });

/** The timer as of `now`: a running timer that has hit zero becomes "ended", otherwise it is re-anchored at `now`. */
export function settleTimer(timer, now) {
  if (timer.status !== "running") return timer;
  const left = Math.max(0, timer.remainingMs - Math.max(0, now - timer.anchor));
  if (left === 0) return { ...timer, status: "ended", remainingMs: 0, anchor: null };
  return { ...timer, remainingMs: left, anchor: now };
}

export function timerView(timer, now) {
  const settled = settleTimer(timer, now);
  return { status: settled.status, remainingMs: settled.remainingMs, addedMs: settled.addedMs };
}

export function startTimer(timer, now) {
  const settled = settleTimer(timer, now);
  if (settled.status === "running" || settled.status === "ended" || settled.remainingMs <= 0) return settled;
  return { ...settled, status: "running", anchor: now };
}

export function pauseTimer(timer, now) {
  const settled = settleTimer(timer, now);
  return settled.status === "running" ? { ...settled, status: "paused", anchor: null } : settled;
}

export const resetTimer = (remainingMs) => createTimer(remainingMs);

/**
 * Adds (or, with a negative number, takes away) time. `maxMs` > 0 is the longest the timer may
 * show: time that would go past it is not added (a timer that is already above it is left alone).
 * An ended timer takes no new time unless `revive` is set; it then comes back paused.
 * Returns the new timer and how many ms were really added.
 */
export function addTime(timer, deltaMs, now, { maxMs = 0, revive = false } = {}) {
  const settled = settleTimer(timer, now);
  if (settled.status === "ended" && !revive) return { timer: settled, appliedMs: 0 };

  let next = settled.remainingMs + deltaMs;
  if (deltaMs > 0 && maxMs > 0) next = Math.min(next, Math.max(settled.remainingMs, maxMs));
  next = Math.max(0, Math.round(next));
  const appliedMs = next - settled.remainingMs;

  let status = settled.status;
  let anchor = settled.anchor;
  if (status === "ended") status = next > 0 ? "paused" : "ended";
  if (status === "running" && next === 0) {
    status = "ended";
    anchor = null;
  }
  return { timer: { ...settled, status, anchor, remainingMs: next, addedMs: settled.addedMs + appliedMs }, appliedMs };
}

// ---- gifts ------------------------------------------------------------------------------

/**
 * Decides how many subs a sub event is really worth. A single sub or resub is worth one. A bulk
 * gift ("X gifted 20 subs") arrives as one summary line (submysterygift) and then as 20 single
 * subgift lines; those belong together and must be counted once, not twice.
 *
 * Lines belong together when they come from the same gifter and carry the same gift id (or one of
 * them carries none), while the bulk gift is still open, i.e. fewer single lines than announced
 * have arrived. That is deliberately strict, because Twitch has been seen to reuse gift ids: two
 * unrelated gifts must never be taken for one. A group is worth the larger of what the summary
 * announced and how many single lines were seen, so a missing line is still paid for and a line
 * that arrives before the summary is not paid twice.
 */
export function createGiftTracker({ windowMs = 5 * 60 * 1000, adoptMs = 10 * 1000, limit = 2000 } = {}) {
  let groups = []; // oldest first

  function prune(now) {
    groups = groups.filter((group) => now - group.touched <= windowMs);
    if (groups.length > limit) groups = groups.slice(-limit);
  }

  const sharesId = (group, event) => event.giftKeys.some((key) => group.keys.has(key));
  const sameGift = (group, event) => group.gifter === event.login && (sharesId(group, event) || event.giftKeys.length === 0 || group.keys.size === 0);

  // A single gift: the gifter's open bulk gift takes it; otherwise it goes with other single gifts that no summary has claimed.
  function groupForSingle(event) {
    return groups.find((group) => group.declared !== null && group.seen < group.declared && sameGift(group, event))
      || groups.find((group) => group.declared === null && sameGift(group, event));
  }

  // A bulk gift: it takes single gifts that arrived just before it, if any, and is otherwise a new gift.
  function groupForBulk(event, now) {
    return groups.find((group) => group.declared === null && now - group.touched <= adoptMs && sameGift(group, event));
  }

  function settle(group, tier) {
    const worth = Math.max(group.declared ?? 0, group.seen);
    const count = worth - group.credited;
    group.credited = worth;
    return { tier, count };
  }

  return {
    /** @returns {{ tier: 1|2|3, count: number }} the subs to pay out for this event (0 when it was already paid for) */
    credit(event, now = Date.now()) {
      prune(now);
      if (event.kind === "sub" || event.kind === "resub") return { tier: event.tier, count: 1 };

      const bulk = event.kind === "submysterygift";
      let group = bulk ? groupForBulk(event, now) : groupForSingle(event);
      if (!group) {
        group = { keys: new Set(), gifter: event.login, declared: null, seen: 0, credited: 0, touched: now };
        groups.push(group);
      }
      for (const key of event.giftKeys) group.keys.add(key);
      group.touched = now;
      if (bulk) group.declared = event.count;
      else group.seen += 1;
      return settle(group, event.tier);
    }
  };
}

// ---- state ------------------------------------------------------------------------------

export function createState({ twitch = null } = {}) {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    timer: createTimer(DEFAULT_SETTINGS.startSeconds * 1000),
    count: 0,
    goals: cleanGoals([{ title: "Sub goal", target: 50 }]),
    events: [], // newest first
    twitch
  };
}

/**
 * Pays out a sub: adds the time for its tier, raises the counter and notes it in the event list.
 * `sub` is { kind, user, recipient, tier, count, test }. Returns the list entry, or null for count 0.
 */
export function registerSubs(state, sub, now = Date.now()) {
  const count = Math.max(0, Math.trunc(sub.count));
  if (!count) return null;
  const { timer, appliedMs } = addTime(state.timer, secondsForTier(state.settings, sub.tier) * 1000 * count, now, {
    maxMs: state.settings.maxSeconds * 1000
  });
  state.timer = timer;
  state.count += count;
  const entry = {
    id: newId(),
    at: new Date(now).toISOString(),
    kind: sub.kind,
    user: String(sub.user || "Unknown").slice(0, 40),
    recipient: sub.recipient ? String(sub.recipient).slice(0, 40) : null,
    tier: sub.tier,
    count,
    addedMs: appliedMs,
    test: Boolean(sub.test)
  };
  state.events.unshift(entry);
  state.events.length = Math.min(state.events.length, LIMITS.events);
  return entry;
}

/** Takes back what the panel's test subs did to the counter and the timer, and removes them from the list. */
export function undoTestEvents(state, now = Date.now()) {
  const tests = state.events.filter((entry) => entry.test);
  if (!tests.length) return 0;
  const count = tests.reduce((sum, entry) => sum + entry.count, 0);
  const addedMs = tests.reduce((sum, entry) => sum + entry.addedMs, 0);
  state.count = Math.max(0, state.count - count);
  if (addedMs) state.timer = addTime(state.timer, -addedMs, now).timer;
  state.events = state.events.filter((entry) => !entry.test);
  return tests.length;
}

export function serializeState(state) {
  const { settings, timer, count, goals, events, twitch } = state;
  return { v: 1, settings, timer, count, goals, events, twitch: twitch ?? "" }; // "" = chosen to read no chat, as opposed to never chosen
}

/** Rebuilds a state from what was saved. Anything that does not look right falls back to the default. */
export function restoreState(saved, { twitch = null } = {}) {
  const state = createState({ twitch });
  if (!saved || typeof saved !== "object") return state;

  try { state.settings = cleanSettings(saved.settings); } catch { /* keep the defaults */ }
  state.timer = createTimer(state.settings.startSeconds * 1000);

  const timer = saved.timer;
  if (timer && ["idle", "running", "paused", "ended"].includes(timer.status) && Number.isFinite(timer.remainingMs) && timer.remainingMs >= 0) {
    const running = timer.status === "running" && Number.isFinite(timer.anchor);
    state.timer = {
      status: timer.status === "running" && !running ? "paused" : timer.status,
      remainingMs: Math.round(timer.remainingMs),
      anchor: running ? timer.anchor : null,
      addedMs: Number.isFinite(timer.addedMs) ? Math.round(timer.addedMs) : 0
    };
  }

  if (Number.isInteger(saved.count) && saved.count >= 0 && saved.count <= LIMITS.count) state.count = saved.count;
  if (Array.isArray(saved.goals)) {
    try { state.goals = cleanGoals(saved.goals); } catch { /* keep the default goal */ }
  }
  if (Array.isArray(saved.events)) {
    state.events = saved.events
      .filter((entry) => entry && typeof entry.id === "string" && Number.isFinite(entry.count) && Number.isFinite(entry.addedMs))
      .slice(0, LIMITS.events);
  }
  if (typeof saved.twitch === "string") state.twitch = saved.twitch || null;
  return state;
}
