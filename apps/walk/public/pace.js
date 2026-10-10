// Gå-tid og tempo. Deles af overlay, panel og tests.

// Standard-tempo (km/t) til den automatiske km-optælling, før du selv har sat et. 4,5 = realistisk på lange dage med oppakning.
export const DEFAULT_SPEED = 4.5;
const one = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const timeText = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} t`;
};

// km/t ud fra km og gå-tid; null indtil der er gået mindst 1 minut og 0,05 km (så tallet ikke hopper vildt).
export const speedKmh = (km, ms) => (ms >= 60000 && km >= 0.05 ? km / (ms / 3600000) : null);

export function paceText(km, ms, unit = "kmh") {
  const v = speedKmh(km, ms);
  if (v === null) return "–";
  if (unit === "minkm") {
    const perKm = 60 / v;
    let m = Math.floor(perKm), s = Math.round((perKm - m) * 60);
    if (s === 60) { m += 1; s = 0; }
    return `${m}:${String(s).padStart(2, "0")} min/km`;
  }
  return `${one.format(v)} km/t`;
}

// "idle" (ikke startet), "running" eller "paused".
export const timerStatus = (t) => (t?.running ? "running" : t?.ms > 0 ? "paused" : "idle");

// ---- Forventet ankomst ----
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const clockText = (ms) => clock.format(ms); // "16:40", altid dansk tid

export const isClock = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

// Dagens forventede ankomst. manual = "HH:MM" sat i panelet (vinder over beregningen).
// Returnerer { text, manual }: text er "16:40", "Fremme" eller "–" (ukendt: ikke gået længe nok endnu).
export function etaInfo({ remainingKm, ms, kmToday, manual, nowMs, walking = true }) {
  if (!walking) return { text: "–", manual: false };
  if (remainingKm <= 0.05) return { text: "Fremme", manual: false };
  if (isClock(manual)) return { text: manual, manual: true };
  const v = speedKmh(kmToday, ms);
  if (v === null) return { text: "–", manual: false };
  return { text: clockText(nowMs + (remainingKm / v) * 3600000), manual: false };
}

// "16:40" + 15 min -> "16:55" (ombrydes ved midnat).
export function shiftClock(hhmm, minutes) {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
