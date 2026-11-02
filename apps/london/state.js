import crypto from "node:crypto";

export const STATUSES = ["todo", "now", "done"];
export const MAX_ITEMS = 40;

const clip = (value, max) => String(value ?? "").trim().slice(0, max);

// "compact" shows only what is happening now and the next stop; "list" shows the whole plan.
export const VIEWS = ["compact", "list"];

export const DEFAULT_PLAN = { kicker: "Plan for London", title: "POWER TRIP: Aggo & Lucas", view: "compact" };

export function cleanPlan(input, existing = DEFAULT_PLAN) {
  const title = typeof input?.title === "string" ? clip(input.title, 40) : "";
  return {
    kicker: typeof input?.kicker === "string" ? clip(input.kicker, 30) : existing.kicker,
    title: title || existing.title,
    view: VIEWS.includes(input?.view) ? input.view : existing.view
  };
}

export const blankItem = (id = crypto.randomUUID()) => ({ id, title: "", note: "", maybe: false, status: "todo", visible: true });

// Merges a patch into an item. Unknown or invalid fields are ignored; an empty title keeps the old one.
export function cleanItem(input, existing = blankItem()) {
  const title = typeof input?.title === "string" ? clip(input.title, 60) : "";
  return {
    id: existing.id,
    title: title || existing.title,
    note: typeof input?.note === "string" ? clip(input.note, 80) : existing.note,
    maybe: typeof input?.maybe === "boolean" ? input.maybe : existing.maybe,
    status: STATUSES.includes(input?.status) ? input.status : existing.status,
    visible: typeof input?.visible === "boolean" ? input.visible : existing.visible
  };
}

// Only one thing is "now" at a time: whatever was running goes back to the queue.
const demote = (item) => (item.status === "now" ? { ...item, status: "todo" } : item);

// Where something that should happen "next" goes: right after what is running now,
// or in front of the first thing still to do.
function nextSlot(items) {
  const now = items.findIndex((item) => item.status === "now");
  if (now !== -1) return now + 1;
  const todo = items.findIndex((item) => item.status === "todo");
  return todo === -1 ? items.length : todo;
}

export function addItem(items, input, position = "end") {
  const item = cleanItem(input);
  if (!item.title || items.length >= MAX_ITEMS) return null;
  const rest = item.status === "now" ? items.map(demote) : items;
  const at = position === "next" ? nextSlot(rest) : rest.length;
  return { items: [...rest.slice(0, at), item, ...rest.slice(at)], item };
}

export function updateItem(items, id, patch) {
  const at = items.findIndex((item) => item.id === id);
  if (at === -1) return null;
  const next = cleanItem(patch, items[at]);
  return items.map((item, i) => (i === at ? next : next.status === "now" ? demote(item) : item));
}

export function removeItem(items, id) {
  return items.filter((item) => item.id !== id);
}

export function moveNext(items, id) {
  const item = items.find((i) => i.id === id);
  if (!item || item.status === "now") return items;
  const rest = items.filter((i) => i.id !== id);
  const at = nextSlot(rest);
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

// "Done, on to the next one": finishes what is running and starts the next thing on the list that is still shown.
export function advance(items) {
  const now = items.findIndex((item) => item.status === "now");
  const finished = items.map((item, i) => (i === now ? { ...item, status: "done" } : item));
  const open = (item) => item.status === "todo" && item.visible;
  let next = finished.findIndex((item, i) => i > now && open(item));
  if (next === -1) next = finished.findIndex(open);
  return finished.map((item, i) => (i === next ? { ...item, status: "now" } : item));
}

export function reorder(items, ids) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = [...new Set(Array.isArray(ids) ? ids : [])].map((id) => byId.get(id)).filter(Boolean);
  for (const item of items) if (!ordered.includes(item)) ordered.push(item);
  return ordered;
}

export const resetStatuses = (items) => items.map((item) => ({ ...item, status: "todo" }));

// What the first visit shows: the plan as Aggo and Lucas described it so far.
export function defaultItems() {
  const make = (title, extra) => cleanItem({ title, ...extra });
  return [
    make("London Eye", { note: "Streamen starter her", maybe: true }),
    make("Nando's"),
    make("Chinatown", { maybe: true }),
    make("Oxford Street"),
    make("Prøv forskellig mad", { maybe: true }),
    make("Skøjte", { maybe: true })
  ];
}

// Reads what was saved in the database, tolerating anything that does not look right.
export function restore(saved) {
  const items = (Array.isArray(saved?.items) ? saved.items : [])
    .map((raw) => cleanItem(raw, blankItem(typeof raw?.id === "string" && raw.id ? raw.id.slice(0, 64) : undefined)))
    .filter((item) => item.title)
    .slice(0, MAX_ITEMS);
  const lastNow = items.map((item) => item.status).lastIndexOf("now");
  return {
    plan: cleanPlan(saved?.plan),
    items: items.map((item, i) => (item.status === "now" && i !== lastNow ? demote(item) : item))
  };
}
