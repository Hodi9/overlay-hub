import crypto from "node:crypto";

// The colour of the stripe and the highlight when someone arrives. The colours themselves are in the overlay.
export const ACCENTS = ["lime", "mint", "blue", "violet", "yellow", "pink", "white", "orange"];
export const MAX_GUESTS = 60;

const clip = (value, max) => String(value ?? "").trim().slice(0, max);

// How big the overlay is, set with the slider in the panel: 1 is the normal size, 0.6 to 2 is 60 % to 200 %.
export const SCALE_MIN = 0.6;
export const SCALE_MAX = 2;

export const DEFAULT_PLAN = { kicker: "I studiet nu", accent: "lime", scale: 1 };

export function cleanPlan(input, existing = DEFAULT_PLAN) {
  const scale = typeof input?.scale === "number" && Number.isFinite(input.scale) ? Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, input.scale)) * 100) / 100 : existing.scale;
  return {
    kicker: typeof input?.kicker === "string" ? clip(input.kicker, 30) : existing.kicker,
    accent: ACCENTS.includes(input?.accent) ? input.accent : existing.accent,
    scale
  };
}

export const blankGuest = (id = crypto.randomUUID()) => ({ id, name: "", role: "", here: false });

// Merges a patch into a guest. Unknown or invalid fields are ignored; an empty name keeps the old one.
// "here" is whether the guest is in the studio now, which is what the overlay shows.
export function cleanGuest(input, existing = blankGuest()) {
  const name = typeof input?.name === "string" ? clip(input.name, 40) : "";
  return {
    id: existing.id,
    name: name || existing.name,
    role: typeof input?.role === "string" ? clip(input.role, 50) : existing.role,
    here: typeof input?.here === "boolean" ? input.here : existing.here
  };
}

export function addGuest(guests, input) {
  const guest = cleanGuest(input);
  if (!guest.name || guests.length >= MAX_GUESTS) return null;
  return { guests: [...guests, guest], guest };
}

export function updateGuest(guests, id, patch) {
  const at = guests.findIndex((guest) => guest.id === id);
  if (at === -1) return null;
  return guests.map((guest, i) => (i === at ? cleanGuest(patch, guest) : guest));
}

export const removeGuest = (guests, id) => guests.filter((guest) => guest.id !== id);

export function reorder(guests, ids) {
  const byId = new Map(guests.map((guest) => [guest.id, guest]));
  const ordered = [...new Set(Array.isArray(ids) ? ids : [])].map((id) => byId.get(id)).filter(Boolean);
  for (const guest of guests) if (!ordered.includes(guest)) ordered.push(guest);
  return ordered;
}

export const everyoneOut = (guests) => guests.map((guest) => ({ ...guest, here: false }));

// Reads what was saved in the database, tolerating anything that does not look right.
export function restore(saved) {
  const guests = (Array.isArray(saved?.guests) ? saved.guests : [])
    .map((raw) => cleanGuest(raw, blankGuest(typeof raw?.id === "string" && raw.id ? raw.id.slice(0, 64) : undefined)))
    .filter((guest) => guest.name)
    .slice(0, MAX_GUESTS);
  return { plan: cleanPlan(saved?.plan), guests };
}
