// Rute 4: Rosenholm Slot -> Gavnø Slot. Data fra etapetabellen (start 12/10; der er ikke længere et fast klokkeslæt for ankomsten, Marcel kommer når han kan). Ændret efter start: Silkeborg-Jelling er skåret fra, og i stedet for toget Nyborg-Korsør går turen over Langeland og Lolland-Falster..
export const START_DATE = "2026-10-12"; // dag 1
export const TZ = "Europe/Copenhagen";

export const TOWNS = {
  rosenholm: { name: "Rosenholm", lat: 56.333, lon: 10.325 },
  aarhus: { name: "Aarhus", lat: 56.157, lon: 10.211 },
  skanderborg: { name: "Skanderborg", lat: 56.045, lon: 9.927 },
  horsens: { name: "Horsens", lat: 55.861, lon: 9.851 },
  vejle: { name: "Vejle", lat: 55.709, lon: 9.536 },
  middelfart: { name: "Middelfart", lat: 55.505, lon: 9.73 },
  aarup: { name: "Aarup", lat: 55.376, lon: 10.049 },
  odense: { name: "Odense", lat: 55.4, lon: 10.39 },
  nyborg: { name: "Nyborg", lat: 55.31, lon: 10.79 },
  svendborg: { name: "Svendborg", lat: 55.06, lon: 10.607 },
  rudkoebing: { name: "Rudkøbing", lat: 54.938, lon: 10.721 },
  spodsbjerg: { name: "Spodsbjerg", lat: 54.935, lon: 10.83 },
  taars: { name: "Tårs", lat: 54.885, lon: 11.115 },
  nakskov: { name: "Nakskov", lat: 54.83, lon: 11.153 },
  maribo: { name: "Maribo", lat: 54.776, lon: 11.501 },
  nykoebing: { name: "Nykøbing F", lat: 54.769, lon: 11.874 },
  vordingborg: { name: "Vordingborg", lat: 55.008, lon: 11.91 },
  naestved: { name: "Næstved", lat: 55.23, lon: 11.76 },
  gavnoe: { name: "Gavnø", lat: 55.1888, lon: 11.7252 }
};

// path = byer etapen går igennem (bruges til position på kortet). ride = færge/tog til etapens start (tegnes stiplet).
export const STAGES = [
  { day: 1, date: "12/10", from: "Rosenholm", to: "Aarhus", km: 22, stay: "Hotel/hostel", path: ["rosenholm", "aarhus"] },
  { day: 2, date: "13/10", from: "Aarhus", to: "Skanderborg", km: 30, stay: "Hotel/shelter", path: ["aarhus", "skanderborg"] },
  { day: 3, date: "14/10", from: "Skanderborg", to: "Horsens", km: 27, stay: "Hotel/hostel", path: ["skanderborg", "horsens"] },
  { day: 4, date: "15/10", from: "Horsens", to: "Vejle", km: 30, stay: "Danhostel Vejle", path: ["horsens", "vejle"] },
  { day: 5, date: "16/10", from: "Vejle", to: "Middelfart", km: 34, stay: "Hotel/hostel", path: ["vejle", "middelfart"] },
  { day: 6, date: "17/10", from: "Middelfart", to: "Aarup", km: 29, stay: "Hotel/shelter", path: ["middelfart", "aarup"] },
  { day: 7, date: "18/10", from: "Aarup", to: "Nyborg", via: "Odense", km: 34, stay: "Hotel", path: ["aarup", "odense", "nyborg"] },
  { day: 8, date: "19/10", from: "Nyborg", to: "Svendborg", km: 38, stay: "Hotel/hostel", path: ["nyborg", "svendborg"] },
  { day: 9, date: "20/10", from: "Svendborg", to: "Spodsbjerg", via: "Rudkøbing", km: 40, stay: "Hotel/hostel", path: ["svendborg", "rudkoebing", "spodsbjerg"] },
  { day: 10, date: "21/10", from: "Tårs", to: "Maribo", via: "Nakskov", km: 36, stay: "Hotel/hostel", ride: { label: "Færge Spodsbjerg → Tårs", from: "spodsbjerg", to: "taars" }, path: ["taars", "nakskov", "maribo"] },
  { day: 11, date: "22/10", from: "Maribo", to: "Nykøbing F", km: 30, stay: "Hotel/hostel", path: ["maribo", "nykoebing"] },
  { day: 12, date: "23/10", from: "Nykøbing F", to: "Vordingborg", km: 33, stay: "Hotel/hostel", path: ["nykoebing", "vordingborg"] },
  { day: 13, date: "24/10", from: "Vordingborg", to: "Næstved", km: 33, stay: "Hotel/hostel", path: ["vordingborg", "naestved"] },
  { day: 14, date: "25/10", from: "Næstved", to: "Gavnø", km: 11, stay: "Gavnø Slot (målet)", path: ["naestved", "gavnoe"] }
];

export const TOTAL_KM = STAGES.reduce((sum, s) => sum + s.km, 0);

export function copenhagenDate(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// 0 = før start, 1..STAGES.length = etape. Efter sidste dato bliver den på sidste etape: "færdig" (STAGES.length + 1) vælges kun manuelt, for Marcel kommer når han kan.
export function dayForDate(now = new Date()) {
  const today = Date.parse(copenhagenDate(now) + "T00:00:00Z");
  const diff = Math.round((today - Date.parse(START_DATE + "T00:00:00Z")) / 86400000) + 1;
  return Math.max(0, Math.min(STAGES.length, diff));
}

// Samlet status ud fra dag + km gået i dag.
export function progress(day, kmToday = 0) {
  const state = day < 1 ? "before" : day > STAGES.length ? "done" : "walking";
  const idx = state === "before" ? 0 : state === "done" ? STAGES.length - 1 : day - 1;
  const stage = STAGES[idx];
  // Km kan overstige etapens planlagte længde (tabellen er kun et estimat); barer og kort stopper dog ved målet.
  const todayKm = state === "done" ? stage.km : Math.max(0, Math.min(kmToday, 100)); // også før start (ellers ser man ingen ændring, når man tester)
  const before = STAGES.slice(0, idx).reduce((sum, s) => sum + s.km, 0);
  const doneKm = before + todayKm;
  return { state, idx, stage, todayKm, doneKm, totalKm: TOTAL_KM, pct: Math.min(1, doneKm / TOTAL_KM), stagePct: Math.min(1, todayKm / stage.km), kmLeft: Math.max(0, TOTAL_KM - doneKm) };
}

// Stien fra etapens start og så langt som `fraction` (0..1) — byerne på vejen og til sidst det interpolerede punkt.
// Bruges til at tegne det stykke af dagens rute, der er gået (lineær pr. segment efter luftlinje).
export function pathUpTo(stage, fraction) {
  const pts = stage.path.map((k) => TOWNS[k]);
  const lens = [];
  for (let i = 1; i < pts.length; i++) lens.push(Math.hypot(pts[i].lat - pts[i - 1].lat, (pts[i].lon - pts[i - 1].lon) * 0.56));
  let target = Math.max(0, Math.min(1, fraction)) * lens.reduce((a, b) => a + b, 0);
  const out = [{ lat: pts[0].lat, lon: pts[0].lon }];
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i] || i === lens.length - 1) {
      const t = lens[i] ? Math.min(1, target / lens[i]) : 0;
      out.push({ lat: pts[i].lat + (pts[i + 1].lat - pts[i].lat) * t, lon: pts[i].lon + (pts[i + 1].lon - pts[i].lon) * t });
      return out;
    }
    out.push({ lat: pts[i + 1].lat, lon: pts[i + 1].lon });
    target -= lens[i];
  }
  return out;
}

// Position langs en etapes byer, fraction 0..1.
export function positionOnStage(stage, fraction) {
  return pathUpTo(stage, fraction).at(-1);
}
