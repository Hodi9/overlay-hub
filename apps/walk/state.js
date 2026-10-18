import { copenhagenDate, STAGES, stageBetween, DEFAULT_STAGE } from "./public/route.js";
import { isClock, DEFAULT_SPEED } from "./public/pace.js";
import { TITLE_MAX, SCALE_MIN, SCALE_MAX, LOOKS, BRIGHTNESS_MIN, isField } from "./public/fields.js";

export const VARIANTS = ["1", "2", "3", "4", "5"];
export const PACE_UNITS = ["kmh", "minkm"];
export const IDLE_TIMER = { running: false, ms: 0, startedAt: null, date: null };
export const DEFAULT_STATE = { from: DEFAULT_STAGE.from, to: DEFAULT_STAGE.to, arrived: false, km: 0, kmDate: null, variant: "1", visible: true, fields: {}, title: "", scale: 1, paceUnit: "kmh", timer: { ...IDLE_TIMER }, eta: null, etaDate: null, kmAuto: true, speed: DEFAULT_SPEED, kmAnchorMs: 0, look: LOOKS[0][0], brightness: 1 };

// Gå-tid i ms lige nu (inkl. det stykke der er i gang).
export const walkMs = (timer, nowMs) => Math.max(0, timer.ms + (timer.running && timer.startedAt ? nowMs - timer.startedAt : 0));

const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
export const SPEED_MIN = 1, SPEED_MAX = 12;

// Dagens km lige nu. Mens uret kører, tæller km op med `speed` (km/t) fra det sted, du sidst rettede dem —
// men aldrig ud over etapens planlagte km (det kan du selv taste, hvis ruten er længere).
// rate = km/t lige nu (0 på pause), cap = hvor langt optællingen går.
export function kmLive(state, now = new Date()) {
  const base = state.km;
  const timer = state.timer || IDLE_TIMER;
  const cap = Math.max(base, (stageBetween(state.from, state.to) || STAGES[0]).km);
  if (!state.kmAuto) return { km: base, rate: 0, cap: base };
  const grown = (Math.max(0, walkMs(timer, now.getTime()) - (state.kmAnchorMs || 0)) / 3600000) * (state.speed || DEFAULT_SPEED);
  const km = Math.min(base + grown, cap);
  return { km, rate: timer.running && km < cap ? state.speed || DEFAULT_SPEED : 0, cap };
}

// Validerer et patch fra kontrolpanelet. Ukendte/ugyldige felter ignoreres.
export function applyPatch(state, patch = {}, now = new Date()) {
  const next = { ...state };
  const today = copenhagenDate(now);
  const live = kmLive(state, now);
  // Hold de optalte km fast, når noget ændrer forudsætningen (tempo, auto til/fra, nyt ur) — ellers hopper tallet.
  let rebase = false, kmSet = false;
  const hold = () => { if (!kmSet) { next.km = round3(live.km); rebase = true; next.kmDate = today; } };
  // Etape: enten en af de planlagte (patch.stage = 1..N) eller egne byer (patch.from + patch.to). Byerne på vejen tages automatisk med.
  if (Number.isInteger(Number(patch.stage)) && Number(patch.stage) >= 1 && Number(patch.stage) <= STAGES.length) {
    next.from = STAGES[Number(patch.stage) - 1].fromKey; next.to = STAGES[Number(patch.stage) - 1].toKey;
  }
  if ("from" in patch || "to" in patch) {
    const f = typeof patch.from === "string" ? patch.from : next.from, t = typeof patch.to === "string" ? patch.to : next.to;
    if (stageBetween(f, t)) { next.from = f; next.to = t; }
  }
  if (typeof patch.arrived === "boolean") next.arrived = patch.arrived;
  if ("km" in patch && patch.km !== "" && patch.km !== null && Number.isFinite(Number(patch.km))) {
    next.km = round1(Math.min(100, Math.max(0, Number(patch.km))));
    next.kmDate = today;
    kmSet = true; // optællingen fortsætter fra den rettede værdi
  }
  if ("speed" in patch && patch.speed !== "" && patch.speed !== null && Number.isFinite(Number(patch.speed))) {
    hold();
    next.speed = round1(Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(patch.speed))));
  }
  if (typeof patch.kmAuto === "boolean" && patch.kmAuto !== state.kmAuto) { hold(); next.kmAuto = patch.kmAuto; }
  if (patch.timer === "start") next.kmDate = today;
  if (patch.timer === "start" && !next.timer.running) next.timer = { ...next.timer, running: true, startedAt: now.getTime(), date: copenhagenDate(now) };
  if (patch.timer === "pause" && next.timer.running) next.timer = { ...next.timer, running: false, ms: walkMs(next.timer, now.getTime()), startedAt: null };
  if (patch.timer === "reset") { hold(); next.timer = { ...IDLE_TIMER }; }
  if ("timerAddMin" in patch && patch.timerAddMin !== "" && patch.timerAddMin !== null && Number.isFinite(Number(patch.timerAddMin))) {
    const add = Math.round(Math.min(600, Math.max(-600, Number(patch.timerAddMin))) * 60000);
    next.timer = { ...next.timer, ms: Math.max(0, next.timer.ms + add), date: today };
    next.kmDate = today;
  }
  if (typeof patch.paceUnit === "string" && PACE_UNITS.includes(patch.paceUnit)) next.paceUnit = patch.paceUnit;
  // Forventet ankomst sat i panelet ("HH:MM", dansk tid). null/"auto"/"" = beregn automatisk.
  if ("eta" in patch) {
    if (patch.eta === null || patch.eta === "" || patch.eta === "auto") { next.eta = null; next.etaDate = null; }
    else if (isClock(patch.eta)) { next.eta = patch.eta; next.etaDate = copenhagenDate(now); }
  }
  // Ny etape fra panelet (også et andet mål fra samme sted, fx etape 3 → 3.1) = nyt ur og ny forventet ankomst.
  if (next.from !== state.from || next.to !== state.to || next.arrived !== state.arrived) { hold(); next.timer = { ...IDLE_TIMER }; next.eta = null; next.etaDate = null; }
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
  if (typeof patch.look === "string" && LOOKS.some(([k]) => k === patch.look)) next.look = patch.look;
  if ("brightness" in patch && patch.brightness !== "" && patch.brightness !== null && Number.isFinite(Number(patch.brightness))) next.brightness = Math.round(Math.min(1, Math.max(BRIGHTNESS_MIN, Number(patch.brightness))) * 100) / 100;
  if (typeof patch.title === "string") next.title = patch.title.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, TITLE_MAX);
  if (kmSet || rebase) next.kmAnchorMs = walkMs(next.timer, now.getTime()); // optællingen starter forfra herfra
  return next;
}

// Det, overlayet og panelet får at se (km og gå-tid regnet op til nu).
export function effectiveState(state, now = new Date()) {
  const timer = state.timer || IDLE_TIMER;
  const timerOut = { running: timer.running, ms: walkMs(timer, now.getTime()) };
  const kl = kmLive(state, now);
  return { from: state.from, to: state.to, arrived: state.arrived === true, km: round3(kl.km), kmRate: kl.rate, kmCap: kl.cap, kmAuto: state.kmAuto !== false, speed: state.speed || DEFAULT_SPEED, variant: state.variant, visible: state.visible, fields: state.fields || {}, title: state.title || "", scale: state.scale ?? 1, paceUnit: state.paceUnit || "kmh", look: state.look || LOOKS[0][0], brightness: state.brightness ?? 1, timer: timerOut, eta: state.eta ?? null };
}

// Gendanner gemt tilstand (fx fra databasen) — også uret, så en genstart midt på dagen ikke mister gå-tiden.
export function restoreState(data = {}, now = new Date()) {
  const t = data.timer || {};
  const timer = {
    running: t.running === true && Number.isFinite(Number(t.startedAt)),
    ms: Number.isFinite(Number(t.ms)) ? Math.max(0, Number(t.ms)) : 0,
    startedAt: Number.isFinite(Number(t.startedAt)) ? Number(t.startedAt) : null,
    date: typeof t.date === "string" ? t.date : null
  };
  const km = Number.isFinite(Number(data.km)) ? Math.min(100, Math.max(0, Number(data.km))) : 0;
  const speed = Number.isFinite(Number(data.speed)) ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(data.speed))) : DEFAULT_SPEED;
  const kmAnchorMs = Number.isFinite(Number(data.kmAnchorMs)) ? Math.max(0, Number(data.kmAnchorMs)) : 0;
  // Ældre tilstand havde en dag (1..N, N+1 = fremme, null = efter dato). Den bliver til den tilsvarende planlagte etape.
  let legacy = {}, legacyAuto = false;
  if (data.day !== undefined && data.from === undefined) {
    let day = data.day;
    if (day === null || day === "auto") {
      legacyAuto = true;
      day = Math.round((Date.parse(copenhagenDate(now) + "T00:00:00Z") - Date.parse("2026-10-12T00:00:00Z")) / 86400000) + 1;
    }
    day = Number(day);
    if (day > STAGES.length) legacy = { stage: STAGES.length, arrived: true };
    else legacy = { stage: Math.max(1, day || 1) };
  }
  // Byer, der er udgået eller har skiftet navn, skal ikke sende gemt tilstand tilbage til etape 1: «hedensted» (før den hed Bredal) og
  // «horsens» (Marcel gik over Bredal) bliver til Bredal, og «vejle» (er ikke længere en by på ruten) til Bredal som start og Middelfart som mål. «aarup» og «skovsgaarde» er blevet til Blommenslyst, og ruten går nu Korsør → Skælskør → Gavnø Slot, så «slagelse» bliver til Skælskør, og «næstved» til Skælskør som start eller Gavnø som mål.
  const renameTo = { hedensted: "bredal", horsens: "bredal", vejle: "middelfart", aarup: "blommenslyst", skovsgaarde: "blommenslyst", slagelse: "skaelskoer", naestved: "gavnoe" }, renameFrom = { hedensted: "bredal", horsens: "bredal", vejle: "bredal", aarup: "blommenslyst", skovsgaarde: "blommenslyst", slagelse: "skaelskoer", naestved: "skaelskoer" };
  if (typeof data.to === "string" && renameTo[data.to]) data = { ...data, to: renameTo[data.to] };
  if (typeof data.from === "string" && renameFrom[data.from]) data = { ...data, from: renameFrom[data.from] };
  const old = legacyAuto && data.kmDate !== copenhagenDate(now); // dengang nulstillede automatisk dag gårsdagens km
  return { ...applyPatch(DEFAULT_STATE, { ...data, ...legacy }), km: old ? 0 : km, speed, kmAnchorMs: old ? 0 : kmAnchorMs, kmAuto: data.kmAuto !== false, kmDate: data.kmDate ?? null, timer: old ? { ...IDLE_TIMER } : timer, eta: !old && isClock(data.eta) ? data.eta : null, etaDate: typeof data.etaDate === "string" ? data.etaDate : null };
}
