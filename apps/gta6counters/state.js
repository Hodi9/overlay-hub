import crypto from "node:crypto";

// GTA VI counters: a few named numbers (deaths, strip club visits, ...) that the panel or a chat command counts up.
// Each counter: { id, label, count, command, visible }. "command" is the chat command that adds 1 (e.g. "!death").
export const MAX_COUNTERS = 8;
export const MAX_COUNT = 999999;
const CHANNEL_RE = /^[a-z0-9_]{2,25}$/;
const COMMAND_RE = /^![a-z0-9æøå_]{1,24}$/;

export const DEFAULT_COUNTERS = [
  { label: "Dødsfald", command: "!death" },
  { label: "Stripklub", command: "!strip" },
  { label: "Brage Lucia", command: "!lucia" }
];

const clip = (value, max) => String(value ?? "").trim().slice(0, max);
const clampCount = (n) => Math.max(0, Math.min(MAX_COUNT, Math.trunc(n)));

export function cleanChannel(value) {
  const cleaned = String(value ?? "").trim().toLowerCase().replace(/^.*twitch\.tv\//, "").replace(/[/?#].*$/, "").replace(/^[@#]/, "");
  if (cleaned === "") return "";
  return CHANNEL_RE.test(cleaned) ? cleaned : null;
}

export function cleanCommand(value) {
  let cleaned = String(value ?? "").trim().toLowerCase();
  if (cleaned === "") return "";
  if (!cleaned.startsWith("!")) cleaned = `!${cleaned}`;
  return COMMAND_RE.test(cleaned) ? cleaned : null;
}

export function makeCounter(input = {}, id = crypto.randomUUID()) {
  return {
    id,
    label: clip(input.label, 30) || "Tæller",
    count: Number.isFinite(input.count) ? clampCount(input.count) : 0,
    command: cleanCommand(input.command) || "",
    visible: input.visible !== false
  };
}

export function defaultState() {
  return { channel: "", counters: DEFAULT_COUNTERS.map((c) => makeCounter(c)) };
}

// Merges a panel edit into a counter. Invalid fields are ignored; returns { counter } or { error }.
export function editCounter(counter, patch) {
  const next = { ...counter };
  if (typeof patch?.label === "string") next.label = clip(patch.label, 30) || counter.label;
  if (typeof patch?.visible === "boolean") next.visible = patch.visible;
  if (Number.isFinite(patch?.count)) next.count = clampCount(patch.count);
  if (patch?.command !== undefined) {
    const command = cleanCommand(patch.command);
    if (command === null) return { error: "Kommandoen skal være ! og op til 24 bogstaver/tal, fx !death." };
    next.command = command;
  }
  return { counter: next };
}

export function bump(counter, by) {
  return { ...counter, count: clampCount(counter.count + by) };
}

// A command may only belong to one counter.
export function commandTaken(counters, command, exceptId) {
  return Boolean(command) && counters.some((c) => c.id !== exceptId && c.command === command);
}

export function counterForCommand(counters, message) {
  const word = String(message ?? "").trim().toLowerCase().split(/\s+/)[0];
  if (!word.startsWith("!")) return null;
  return counters.find((c) => c.command && c.command === word) || null;
}

export function reorder(counters, ids) {
  const byId = new Map(counters.map((c) => [c.id, c]));
  const ordered = [...new Set(Array.isArray(ids) ? ids : [])].map((id) => byId.get(id)).filter(Boolean);
  for (const c of counters) if (!ordered.includes(c)) ordered.push(c);
  return ordered;
}

export function restore(saved) {
  if (!saved || typeof saved !== "object" || !Array.isArray(saved.counters)) return defaultState();
  const seen = new Set();
  const counters = saved.counters.slice(0, MAX_COUNTERS).map((c) => makeCounter(c, typeof c?.id === "string" && c.id ? c.id : undefined))
    .filter((c) => !seen.has(c.id) && seen.add(c.id));
  return { channel: cleanChannel(saved.channel) || "", counters };
}
