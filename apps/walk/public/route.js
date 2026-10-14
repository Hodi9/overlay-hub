// Rute 4: Rosenholm Slot -> Gavnø Slot (start 12/10). Ruten er en kæde af byer med km mellem dem; en etape er blot et start- og målpunkt på kæden.
// Der er ikke længere noget fast tidspunkt eller datoer: Marcel kommer når han kan.
export const TZ = "Europe/Copenhagen";

export const TOWNS = {
  rosenholm: { name: "Rosenholm", lat: 56.333, lon: 10.325 },
  aarhus: { name: "Aarhus", lat: 56.157, lon: 10.211 },
  skanderborg: { name: "Skanderborg", lat: 56.045, lon: 9.927 },
  middelfart: { name: "Middelfart", lat: 55.505, lon: 9.73 },
  aarup: { name: "Aarup", lat: 55.376, lon: 10.049 },
  odense: { name: "Odense", lat: 55.4, lon: 10.39 },
  nyborg: { name: "Nyborg", lat: 55.31, lon: 10.79 },
  korsoer: { name: "Korsør", lat: 55.33, lon: 11.14 },
  slagelse: { name: "Slagelse", lat: 55.4, lon: 11.35 },
  bredal: { name: "Bredal", lat: 55.764, lon: 9.622 }, // Bredal Kro, Horsensvej 581 (ved Vejle)
  naestved: { name: "Næstved", lat: 55.23, lon: 11.76 },
  gavnoe: { name: "Gavnø", lat: 55.1888, lon: 11.7252 }
};

export function copenhagenDate(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// Byerne i rækkefølge. LEGS[i] er stykket fra WAYPOINTS[i] til WAYPOINTS[i+1] (km er estimater; en færge tæller 0 km).
export const WAYPOINTS = ["rosenholm", "aarhus", "skanderborg", "bredal", "middelfart", "aarup", "odense", "nyborg", "korsoer", "slagelse", "naestved", "gavnoe"];
export const LEGS = [
  { km: 22 }, { km: 30 }, { km: 39 }, { km: 38 }, { km: 29 }, { km: 27 }, { km: 34 },
  { km: 0, ride: "Tog Nyborg → Korsør" },
  { km: 11 }, { km: 22 }, { km: 11 }
];
// Km fra start til hver by.
export const CUM = WAYPOINTS.map((_, i) => LEGS.slice(0, i).reduce((sum, l) => sum + l.km, 0));
export const TOTAL_KM = CUM[CUM.length - 1];
const wi = (key) => WAYPOINTS.indexOf(key);

// Samler en etape fra by til by. Byerne på vejen tages automatisk med, og km er summen af stykkerne.
// Ugyldigt (ukendt by, eller målet ligger før starten) giver null.
export function stageBetween(fromKey, toKey) {
  const i = wi(fromKey), j = wi(toKey);
  if (i < 0 || j <= i) return null;
  const path = WAYPOINTS.slice(i, j + 1);
  const legs = LEGS.slice(i, j);
  const rideLeg = legs.findIndex((l) => l.ride);
  const preset = PRESETS.findIndex((p) => p.i === i && p.j === j);
  return {
    n: preset + 1, // 0 = egen etape (ikke en af de planlagte)
    from: TOWNS[fromKey].name, to: TOWNS[toKey].name, fromKey, toKey,
    km: CUM[j] - CUM[i], startKm: CUM[i], endKm: CUM[j],
    path, legs,
    via: path.slice(1, -1).map((k) => TOWNS[k].name).join(", "),
    // Færge/tog på etapen — eller lige før dens start (så etapen kan vise, hvordan Marcel kom hertil).
    ride: rideLeg >= 0 ? { label: legs[rideLeg].ride, from: path[rideLeg], to: path[rideLeg + 1] } : i > 0 && LEGS[i - 1].ride ? { label: LEGS[i - 1].ride, from: WAYPOINTS[i - 1], to: WAYPOINTS[i] } : null,
    stay: preset >= 0 ? PRESETS[preset].stay : ""
  };
}

// De planlagte etaper (kan ændres i kontrolpanelet ved at vælge andre byer).
const PRESETS = [
  { i: 0, j: 1, stay: "Hotel/hostel" }, { i: 1, j: 2, stay: "Hotel/shelter" }, { i: 2, j: 3, stay: "Hotel/hostel" }, { i: 3, j: 4, stay: "Hotel/hostel" },
  { i: 4, j: 5, stay: "Hotel/shelter" }, { i: 5, j: 6, stay: "Hotel" }, { i: 6, j: 7, stay: "Hotel" }, { i: 8, j: 10, stay: "Hotel/shelter" }, { i: 10, j: 11, stay: "Gavnø Slot (målet)" }
];
export const STAGES = PRESETS.map((p) => stageBetween(WAYPOINTS[p.i], WAYPOINTS[p.j]));
export const DEFAULT_STAGE = { from: STAGES[0].fromKey, to: STAGES[0].toKey };

// Den planlagte etape, der ligger efter denne (den første, der starter ved eller efter etapens mål) — eller null.
export const nextPlanned = (stage) => STAGES.find((s) => s.startKm >= stage.endKm - 1e-9) || null;
// Den planlagte etape før denne (den sidste, der slutter ved eller før etapens start) — eller null.
export const prevPlanned = (stage) => [...STAGES].reverse().find((s) => s.endKm <= stage.startKm + 1e-9) || null;

// Samlet status ud fra etapen + km gået på den. `arrived` = Marcel er fremme.
export function progress(stage, kmToday = 0, arrived = false) {
  const state = arrived ? "done" : "walking";
  // Km kan overstige etapens planlagte længde (tabellen er kun et estimat); barer og kort stopper dog ved målet.
  const todayKm = arrived ? stage.km : Math.max(0, Math.min(kmToday, 100));
  const doneKm = arrived ? TOTAL_KM : stage.startKm + todayKm;
  const pos = Math.min(doneKm, TOTAL_KM);
  let idx = 0;
  STAGES.forEach((s, i) => { if (s.startKm <= pos + 1e-9) idx = i; }); // den planlagte etape, Marcel er på
  return { state, idx, stage, todayKm, doneKm, posKm: pos, totalKm: TOTAL_KM, pct: Math.min(1, doneKm / TOTAL_KM), stagePct: Math.min(1, todayKm / stage.km), kmLeft: Math.max(0, TOTAL_KM - doneKm) };
}

// Stien fra etapens start og så langt som `fraction` (0..1) af etapens km — byerne på vejen og til sidst det interpolerede punkt.
// Bruges til at tegne det stykke af etapen, der er gået. En færge (0 km) springes over i ét hop.
export function pathUpTo(stage, fraction) {
  const pts = stage.path.map((k) => TOWNS[k]);
  const lens = stage.legs.map((l) => l.km);
  const total = lens.reduce((a, b) => a + b, 0);
  let target = Math.max(0, Math.min(1, fraction)) * total;
  const out = [{ lat: pts[0].lat, lon: pts[0].lon }];
  for (let i = 0; i < lens.length; i++) {
    if ((lens[i] > 0 && target <= lens[i]) || i === lens.length - 1) {
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
