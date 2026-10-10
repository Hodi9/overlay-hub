import { copenhagenDate } from "./public/route.js";

export const VARIANTS = ["1", "2", "3", "4"];
export const DEFAULT_STATE = { day: null, km: 0, kmDate: null, variant: "1", visible: true };

const round1 = (n) => Math.round(n * 10) / 10;

// Validerer et patch fra kontrolpanelet. Ukendte/ugyldige felter ignoreres.
export function applyPatch(state, patch = {}, now = new Date()) {
  const next = { ...state };
  if ("day" in patch) {
    if (patch.day === null || patch.day === "auto") next.day = null;
    else if (Number.isInteger(Number(patch.day)) && Number(patch.day) >= 0 && Number(patch.day) <= 15) next.day = Number(patch.day);
  }
  if ("km" in patch && patch.km !== "" && patch.km !== null && Number.isFinite(Number(patch.km))) {
    next.km = round1(Math.min(100, Math.max(0, Number(patch.km))));
    next.kmDate = copenhagenDate(now);
  }
  if ("variant" in patch && VARIANTS.includes(String(patch.variant))) next.variant = String(patch.variant);
  if (typeof patch.visible === "boolean") next.visible = patch.visible;
  return next;
}

// I automatisk dag-tilstand nulstilles dagens km ved datoskifte, så gårsdagens km ikke hænger ved.
export function effectiveState(state, now = new Date()) {
  const stale = state.day === null && state.kmDate !== copenhagenDate(now);
  return { day: state.day, km: stale ? 0 : state.km, variant: state.variant, visible: state.visible };
}
