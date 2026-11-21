import crypto from "node:crypto";

// "GTA IRL": missions, places to go and things to do on a real-life stream, ticked off as they are done.
// The current goal is the first one not done yet, the next goal the one after it; the order is the order of the list.
// A goal has a title ("Double or nothing") and an optional detail ("CPH Concept coinflip").
export const KINDS = ["mission", "place", "activity"];
export const MAX_GOALS = 60;
export const WANTED_MAX = 5;

const clip = (value, max) => String(value ?? "").trim().slice(0, max);

// How big the overlay is, set with the slider in the panel: 1 is the normal size, 0.6 to 2 is 60 % to 200 %.
export const SCALE_MIN = 0.6;
export const SCALE_MAX = 2;

// showAll: the whole list on the overlay instead of only the current and the next goal.
// wanted: the wanted level, 0 to 5 stars (0 hides the stars).
export const DEFAULT_PLAN = { title: "GTA IRL", showAll: false, scale: 1, wanted: 0 };

export function cleanPlan(input, existing = DEFAULT_PLAN) {
  const scale = typeof input?.scale === "number" && Number.isFinite(input.scale) ? Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, input.scale)) * 100) / 100 : existing.scale;
  const wanted = Number.isInteger(input?.wanted) ? Math.min(WANTED_MAX, Math.max(0, input.wanted)) : (Number.isInteger(existing.wanted) ? existing.wanted : 0);
  return {
    title: typeof input?.title === "string" ? clip(input.title, 30) : existing.title,
    showAll: typeof input?.showAll === "boolean" ? input.showAll : existing.showAll,
    scale,
    wanted
  };
}

export const blankGoal = (id = crypto.randomUUID()) => ({ id, kind: "mission", text: "", detail: "", done: false });

// Merges a patch into a goal. Unknown or invalid fields are ignored; an empty title keeps the old one.
export function cleanGoal(input, existing = blankGoal()) {
  const text = typeof input?.text === "string" ? clip(input.text, 60) : "";
  return {
    id: existing.id,
    kind: KINDS.includes(input?.kind) ? input.kind : existing.kind,
    text: text || existing.text,
    detail: typeof input?.detail === "string" ? clip(input.detail, 80) : (existing.detail || ""),
    done: typeof input?.done === "boolean" ? input.done : existing.done
  };
}

// One line of a pasted list, as Anker writes them: "MISSION 1: DOUBLE OR NOTHING – CPH CONCEPT COINFLIP".
// Bullets, numbers and "Mission 1:" go (the overlay numbers the missions itself), and a dash between words splits
// the title from the detail. A heading such as "MISSIONER" on its own line is not a goal.
export function parseLine(line) {
  const cleaned = String(line ?? "")
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "")
    .replace(/^\s*mission(?:er)?\s*\d+\s*[:.)\-–—]?\s*/i, "")
    .trim();
  if (!cleaned || /^(missioner|missions?|mål|goals?|liste|list)\s*:?$/i.test(cleaned)) return null;
  const split = /\s+[–—-]\s+/.exec(cleaned);
  if (!split) return { text: cleaned, detail: "" };
  return { text: cleaned.slice(0, split.index).trim(), detail: cleaned.slice(split.index + split[0].length).trim() };
}

// Adds one goal, or several at once (one per line of `text`). Empty lines and headings are skipped.
export function addGoals(goals, input) {
  const parsed = String(input?.text ?? "").split(/\r?\n/).map(parseLine).filter((line) => line && line.text);
  const room = MAX_GOALS - goals.length;
  if (!parsed.length || room <= 0) return null;
  const added = parsed.slice(0, room).map((line) => cleanGoal({ kind: input?.kind, text: line.text, detail: line.detail, done: false }));
  return { goals: [...goals, ...added], added };
}

export function updateGoal(goals, id, patch) {
  const at = goals.findIndex((goal) => goal.id === id);
  if (at === -1) return null;
  return goals.map((goal, i) => (i === at ? cleanGoal(patch, goal) : goal));
}

export const removeGoal = (goals, id) => goals.filter((goal) => goal.id !== id);

export function reorder(goals, ids) {
  const byId = new Map(goals.map((goal) => [goal.id, goal]));
  const ordered = [...new Set(Array.isArray(ids) ? ids : [])].map((id) => byId.get(id)).filter(Boolean);
  for (const goal of goals) if (!ordered.includes(goal)) ordered.push(goal);
  return ordered;
}

// Ticks off the current goal (the first one not done). Nothing changes when everything is done.
export function completeCurrent(goals) {
  const at = goals.findIndex((goal) => !goal.done);
  return at === -1 ? goals : goals.map((goal, i) => (i === at ? { ...goal, done: true } : goal));
}

// Takes the tick off the goal ticked last in the list, so "Fortryd" undoes "Klaret".
export function undoLast(goals) {
  let at = -1;
  goals.forEach((goal, i) => { if (goal.done) at = i; });
  return at === -1 ? goals : goals.map((goal, i) => (i === at ? { ...goal, done: false } : goal));
}

export const resetAll = (goals) => goals.map((goal) => ({ ...goal, done: false }));

// The goal that was ticked off between two versions of the list (the last one, if several), or null.
export function newlyDone(before, after) {
  const wasDone = new Set(before.filter((goal) => goal.done).map((goal) => goal.id));
  const fresh = after.filter((goal) => goal.done && !wasDone.has(goal.id));
  return fresh[fresh.length - 1] || null;
}

// "Mission 2" for the second mission on the list (places and activities are not counted), else "".
export function missionLabel(goals, id) {
  const missions = goals.filter((goal) => goal.kind === "mission");
  const at = missions.findIndex((goal) => goal.id === id);
  return at === -1 ? "" : `Mission ${at + 1}`;
}

// What the overlay shows: how far they are, the goal they are on now and the one after it.
export function progress(goals) {
  const open = goals.filter((goal) => !goal.done);
  const done = goals.length - open.length;
  return {
    done,
    total: goals.length,
    percent: goals.length ? Math.round((done / goals.length) * 1000) / 10 : 0,
    current: open[0] || null,
    next: open[1] || null,
    finished: goals.length > 0 && open.length === 0
  };
}

// Reads what was saved in the database, tolerating anything that does not look right.
export function restore(saved) {
  const goals = (Array.isArray(saved?.goals) ? saved.goals : [])
    .map((raw) => cleanGoal(raw, blankGoal(typeof raw?.id === "string" && raw.id ? raw.id.slice(0, 64) : undefined)))
    .filter((goal) => goal.text)
    .slice(0, MAX_GOALS);
  return { plan: cleanPlan(saved?.plan), goals };
}
