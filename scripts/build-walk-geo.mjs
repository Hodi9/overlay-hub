// Bygger apps/walk/public/geo.js (kystlinjer til Marcel Walk-overlayet) ud fra Natural Earth
// (public domain) via npm-pakken world-atlas. Kør kun når kortet skal laves om:
//   npm i --no-save world-atlas@2.0.2 topojson-client@3 && node scripts/build-walk-geo.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { feature } = require("topojson-client");
const load = (f) => JSON.parse(fs.readFileSync(require.resolve(`world-atlas/${f}`), "utf8"));

// ---- projektion: Danmark (lon/lat -> kort-px), skaleret efter cos(bredde) ----
const DK = { lon0: 7.2, lon1: 13.6, lat0: 54.5, lat1: 57.0, w: 1100 };
DK.kx = Math.cos(55.7 * Math.PI / 180);
DK.k = DK.w / ((DK.lon1 - DK.lon0) * DK.kx);
DK.h = Math.round((DK.lat1 - DK.lat0) * DK.k);
const dk = ([lon, lat]) => [(lon - DK.lon0) * DK.kx * DK.k, (DK.lat1 - lat) * DK.k];

// ---- projektion: verden (ligerektangulær, 58°S–84°N) ----
const WD = { w: 1000, lat0: -58, lat1: 84 };
WD.k = WD.w / 360;
WD.h = Math.round((WD.lat1 - WD.lat0) * WD.k);
const wd = ([lon, lat]) => [(lon + 180) * WD.k, (WD.lat1 - lat) * WD.k];

// Sutherland–Hodgman mod en rektangel (i lon/lat).
function clipRing(ring, [x0, y0, x1, y1]) {
  const edges = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]]
  ];
  let out = ring.slice(0, -1);
  for (const [inside, cut] of edges) {
    const input = out; out = [];
    input.forEach((cur, i) => {
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) { if (!inside(prev)) out.push(cut(prev, cur)); out.push(cur); }
      else if (inside(prev)) out.push(cut(prev, cur));
    });
    if (!out.length) return [];
  }
  return out;
}

// Douglas–Peucker i px.
function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let max = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len; if (d > max) { max = d; idx = i; } }
    if (max > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function unwrapRing(ring) {
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    let x = ring[i][0];
    const px = out[i - 1][0];
    while (x - px > 180) x -= 360;
    while (x - px < -180) x += 360;
    out.push([x, ring[i][1]]);
  }
  return out;
}

function toPath(geom, project, clip, tol, minArea, unwrap = false) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let d = "";
  for (const poly of polys) for (const ring of poly) {
    // Ringe der krydser datolinjen (Rusland, Fiji) gøres sammenhængende og tegnes både
    // som de er og forskudt ±360°, hver især klippet til kortet — ellers får man striber hen over verden.
    const base = unwrap ? unwrapRing(ring) : ring;
    for (const shift of unwrap ? [-360, 0, 360] : [0]) {
      const shifted = shift ? base.map(([x, y]) => [x + shift, y]) : base;
      const c = clip ? clipRing(shifted, clip) : shifted.slice(0, -1);
      if (c.length < 3) continue;
      const px = simplify(c.map(project), tol);
      if (px.length < 3) continue;
      let area = 0; px.forEach((p, i) => { const q = px[(i + 1) % px.length]; area += p[0] * q[1] - q[0] * p[1]; });
      if (Math.abs(area) / 2 < minArea) continue;
      d += "M" + px.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L") + "Z";
    }
  }
  return d;
}

const feats = (topo, obj) => feature(topo, topo.objects[obj]).features;
const c10 = load("countries-10m.json");
const byName = (n) => feats(c10, "countries").find((f) => f.properties.name === n).geometry;
const box = [DK.lon0 - 0.05, DK.lat0 - 0.05, DK.lon1 + 0.05, DK.lat1 + 0.05];
const out = {
  DK_LAND: toPath(byName("Denmark"), dk, box, 0.35, 4),
  DK_NEIGHBORS: toPath({ type: "MultiPolygon", coordinates: ["Germany", "Sweden"].flatMap((n) => { const g = byName(n); return g.type === "Polygon" ? [g.coordinates] : g.coordinates; }) }, dk, box, 0.35, 4)
};
const l110 = load("land-110m.json");
const land = feats(l110, "land").map((f) => f.geometry);
out.WORLD_LAND = land.map((g) => toPath(g, wd, [-180, WD.lat0, 180, WD.lat1], 0.25, 1, true)).join("");
const c110 = load("countries-110m.json");
out.WORLD_DK = toPath(feats(c110, "countries").find((f) => f.properties.name === "Denmark").geometry, wd, null, 0, 0);

const num = (n) => +n.toFixed(4);
const src = `// GENERERET af scripts/build-walk-geo.mjs — Natural Earth (public domain) via world-atlas. Ret ikke i hånden.
export const DK_VIEW = { w: ${DK.w}, h: ${DK.h}, lon0: ${DK.lon0}, lat1: ${DK.lat1}, kx: ${num(DK.kx)}, k: ${num(DK.k)} };
export const dkXY = (lon, lat) => [(lon - DK_VIEW.lon0) * DK_VIEW.kx * DK_VIEW.k, (DK_VIEW.lat1 - lat) * DK_VIEW.k];
export const WORLD_VIEW = { w: ${WD.w}, h: ${WD.h}, lat1: ${WD.lat1}, k: ${num(WD.k)} };
export const worldXY = (lon, lat) => [(lon + 180) * WORLD_VIEW.k, (WORLD_VIEW.lat1 - lat) * WORLD_VIEW.k];
${Object.entries(out).map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`).join("\n")}
`;
fs.writeFileSync("apps/walk/public/geo.js", src);
console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])), "view", DK.w, DK.h, "total", src.length);
