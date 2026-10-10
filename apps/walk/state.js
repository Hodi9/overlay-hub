import { copenhagenDate } from "./public/route.js";
import { isClock } from "./public/pace.js";
import { TITLE_MAX, SCALE_MIN, SCALE_MAX, isField } from "./public/fields.js";

export const VARIANTS = ["1", "2", "3", "4", "5"];
export const PACE_UNITS = ["kmh", "minkm"];
export const IDLE_TIMER = { running: false, ms: 0, startedAt: null, date: null };
export const DEFAULT_STATE = { day: null, km: 0, kmDate: null, variant: "1", visible: true, fields: {}, title: "", scale: 1, paceUnit: "kmh", timer: { ...IDLE_TIMER }, eta: null, etaDate: null };

// Gå-tid i ms lige nu (inkl. det stykke der er i gang).
export const walkMs = (timer, nowMs) => Math.max(0, timer.ms + (timer.running && timer.startedAt ? nowMs - timer.startedAt : 0));

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
  if (patch.timer === "start" && !next.timer.running) next.timer = { ...next.timer, running: true, startedAt: now.getTime(), date: copenhagenDate(now) };
  if (patch.timer === "pause" && next.timer.running) next.timer = { ...next.timer, running: false, ms: walkMs(next.timer, now.getTime()), startedAt: null };
  if (patch.timer === "reset") next.timer = { ...IDLE_TIMER };
  if ("timerAddMin" in patch && patch.timerAddMin !== "" && patch.timerAddMin !== null && Number.isFinite(Number(patch.timerAddMin))) {
    const add = Math.round(Math.min(600, Math.max(-600, Number(patch.timerAddMin))) * 60000);
    next.timer = { ...next.timer, ms: Math.max(0, next.timer.ms + add), date: copenhagenDate(now) };
  }
  if (typeof patch.paceUnit === "string" && PACE_UNITS.includes(patch.paceUnit)) next.paceUnit = patch.paceUnit;
  // Forventet ankomst sat i panelet ("HH:MM", dansk tid). null/"auto"/"" = beregn automatisk.
  if ("eta" in patch) {
    if (patch.eta === null || patch.eta === "" || patch.eta === "auto") { next.eta = null; next.etaDate = null; }
    else if (isClock(patch.eta)) { next.eta = patch.eta; next.etaDate = copenhagenDate(now); }
  }
  // Ny dag fra panelet = nyt ur og ny forventet ankomst.
  if ("day" in patch && next.day !== state.day) { next.timer = { ...IDLE_TIMER }; next.eta = null; next.etaDate = null; }
  if ("variant" in patch && VARIANTS.includes(String(patch.variant))) next.variant = String(patch.variant);
  if (typeof patch.visible === "boolean") next.visible = patch.visible;
  if (patch.fields && typeof patch.fields === "object") {
    next.fields = { ...next.fields };
    for (const v of VARIANTS) {
      const incoming = patch.fields[v];
      if (!incoming || typeof incoming !== "object") continue;
      const merged = { ...next.fields[v] };
      for (const [key, on] of Object.entries(incoming)) if (isField(v, key) && typeof on === "boolean") merged[key] = on;
      next.fields[v] = merged;
    }
  }
  if ("scale" in patch && patch.scale !== "" && patch.scale !== null && Number.isFinite(Number(patch.scale))) next.scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(patch.scale))) * 100) / 100;
  if (typeof patch.title === "string") next.title = patch.title.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, TITLE_MAX);
  return next;
}

// I automatisk dag-tilstand nulstilles dagens km ved datoskifte, så gårsdagens km ikke hænger ved.
export function effectiveState(state, now = new Date()) {
  const stale = state.day === null && state.kmDate !== copenhagenDate(now);
  const timer = state.timer || IDLE_TIMER;
  const timerStale = state.day === null && timer.date && timer.date !== copenhagenDate(now); // også uret nulstilles ved midnat
  const etaStale = state.day === null && state.eta && state.etaDate !== copenhagenDate(now); // en sat ankomst gælder kun i dag
  const timerOut = timerStale ? { running: false, ms: 0 } : { running: timer.running, ms: walkMs(timer, now.getTime()) };
  return { day: state.day, km: stale ? 0 : state.km, variant: state.variant, visible: state.visible, fields: state.fields || {}, title: state.title || "", scale: state.scale ?? 1, paceUnit: state.paceUnit || "kmh", timer: timerOut, eta: etaStale ? null : state.eta ?? null };
}

// Gendanner gemt tilstand (fx fra databasen) — også uret, så en genstart midt på dagen ikke mister gå-tiden.
export function restoreState(data = {}) {
  const t = data.timer || {};
  const timer = {
    running: t.running === true && Number.isFinite(Number(t.startedAt)),
    ms: Number.isFinite(Number(t.ms)) ? Math.max(0, Number(t.ms)) : 0,
    startedAt: Number.isFinite(Number(t.startedAt)) ? Number(t.startedAt) : null,
    date: typeof t.date === "string" ? t.date : null
  };
  return { ...applyPatch(DEFAULT_STATE, data), kmDate: data.kmDate ?? null, timer, eta: isClock(data.eta) ? data.eta : null, etaDate: typeof data.etaDate === "string" ? data.etaDate : null };
}
