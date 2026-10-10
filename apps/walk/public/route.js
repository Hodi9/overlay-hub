// Rute 4: Rosenholm Slot -> Gavnø Slot. Data fra etapetabellen (12/10 - 25/10).
export const START_DATE = "2026-10-12"; // dag 1
export const TZ = "Europe/Copenhagen";

export const TOWNS = {
  rosenholm: { name: "Rosenholm", lat: 56.333, lon: 10.325 },
  aarhus: { name: "Aarhus", lat: 56.157, lon: 10.211 },
  skanderborg: { name: "Skanderborg", lat: 56.045, lon: 9.927 },
  silkeborg: { name: "Silkeborg", lat: 56.17, lon: 9.545 },
  ikast: { name: "Ikast", lat: 56.139, lon: 9.155 },
  herning: { name: "Herning", lat: 56.139, lon: 8.976 },
  brande: { name: "Brande", lat: 55.94, lon: 9.12 },
  give: { name: "Give", lat: 55.84, lon: 9.23 },
  jelling: { name: "Jelling", lat: 55.756, lon: 9.419 },
  horsens: { name: "Horsens", lat: 55.861, lon: 9.851 },
  vejle: { name: "Vejle", lat: 55.709, lon: 9.536 },
  middelfart: { name: "Middelfart", lat: 55.505, lon: 9.73 },
  aarup: { name: "Aarup", lat: 55.376, lon: 10.049 },
  odense: { name: "Odense", lat: 55.4, lon: 10.39 },
  nyborg: { name: "Nyborg", lat: 55.31, lon: 10.79 },
  korsoer: { name: "Korsør", lat: 55.33, lon: 11.14 },
  slagelse: { name: "Slagelse", lat: 55.4, lon: 11.35 },
  naestved: { name: "Næstved", lat: 55.23, lon: 11.76 },
  gavnoe: { name: "Gavnø", lat: 55.1888, lon: 11.7252 }
};

// path = byer etapen går igennem (bruges til position på kortet).
export const STAGES = [
  { day: 1, date: "12/10", from: "Rosenholm", to: "Aarhus", km: 22, stay: "Hotel/hostel", path: ["rosenholm", "aarhus"] },
  { day: 2, date: "13/10", from: "Aarhus", to: "Skanderborg", km: 30, stay: "Hotel/shelter", path: ["aarhus", "skanderborg"] },
  { day: 3, date: "14/10", from: "Skanderborg", to: "Silkeborg", km: 32, stay: "Danhostel Silkeborg", path: ["skanderborg", "silkeborg"] },
  { day: 4, date: "15/10", from: "Silkeborg", to: "Ikast", km: 35, stay: "Hotel/shelter", path: ["silkeborg", "ikast"] },
  { day: 5, date: "16/10", from: "Ikast", to: "Herning", km: 18, stay: "Hotel", path: ["ikast", "herning"] },
  { day: 6, date: "17/10", from: "Herning", to: "Brande", km: 34, stay: "Shelter/telt", path: ["herning", "brande"] },
  { day: 7, date: "18/10", from: "Brande", to: "Jelling", via: "Give", km: 35, stay: "Hotel/hostel", path: ["brande", "give", "jelling"] },
  { day: 8, date: "19/10", from: "Jelling", to: "Horsens", km: 35, stay: "Hotel/hostel", path: ["jelling", "horsens"] },
  { day: 9, date: "20/10", from: "Horsens", to: "Vejle", km: 30, stay: "Danhostel Vejle", path: ["horsens", "vejle"] },
  { day: 10, date: "21/10", from: "Vejle", to: "Middelfart", km: 34, stay: "Hotel/hostel", path: ["vejle", "middelfart"] },
  { day: 11, date: "22/10", from: "Middelfart", to: "Aarup", km: 29, stay: "Hotel/shelter", path: ["middelfart", "aarup"] },
  { day: 12, date: "23/10", from: "Aarup", to: "Nyborg", via: "Odense", km: 34, stay: "Hotel", path: ["aarup", "odense", "nyborg"] },
  { day: 13, date: "24/10", from: "Korsør", to: "Næstved", via: "Slagelse", km: 33, stay: "Hotel/shelter", train: "Tog Nyborg → Korsør", path: ["korsoer", "slagelse", "naestved"] },
  { day: 14, date: "25/10", from: "Næstved", to: "Gavnø", km: 11, stay: "Gavnø kl. 15", path: ["naestved", "gavnoe"] }
];

export const TOTAL_KM = STAGES.reduce((sum, s) => sum + s.km, 0);

export function copenhagenDate(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// 0 = før start, 1..14 = etape, 15 = færdig.
export function dayForDate(now = new Date()) {
  const today = Date.parse(copenhagenDate(now) + "T00:00:00Z");
  const diff = Math.round((today - Date.parse(START_DATE + "T00:00:00Z")) / 86400000) + 1;
  return Math.max(0, Math.min(STAGES.length + 1, diff));
}

// Samlet status ud fra dag + km gået i dag.
export function progress(day, kmToday = 0) {
  const state = day < 1 ? "before" : day > STAGES.length ? "done" : "walking";
  const idx = state === "before" ? 0 : state === "done" ? STAGES.length - 1 : day - 1;
  const stage = STAGES[idx];
  const todayKm = state === "walking" ? Math.max(0, Math.min(kmToday, stage.km)) : state === "done" ? stage.km : 0;
  const before = STAGES.slice(0, idx).reduce((sum, s) => sum + s.km, 0);
  const doneKm = before + todayKm;
  return { state, idx, stage, todayKm, doneKm, totalKm: TOTAL_KM, pct: doneKm / TOTAL_KM, stagePct: todayKm / stage.km, kmLeft: TOTAL_KM - doneKm };
}

// Position langs en etapes byer, fraction 0..1 (lineær pr. segment efter luftlinje).
export function positionOnStage(stage, fraction) {
  const pts = stage.path.map((k) => TOWNS[k]);
  const lens = [];
  for (let i = 1; i < pts.length; i++) lens.push(Math.hypot(pts[i].lat - pts[i - 1].lat, (pts[i].lon - pts[i - 1].lon) * 0.56));
  let target = Math.max(0, Math.min(1, fraction)) * lens.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i] || i === lens.length - 1) {
      const t = lens[i] ? Math.min(1, target / lens[i]) : 0;
      return { lat: pts[i].lat + (pts[i + 1].lat - pts[i].lat) * t, lon: pts[i].lon + (pts[i + 1].lon - pts[i].lon) * t };
    }
    target -= lens[i];
  }
  return { lat: pts[0].lat, lon: pts[0].lon };
}
