// Gå-tid og tempo. Deles af overlay, panel og tests.
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
