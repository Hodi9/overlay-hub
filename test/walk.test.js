import test from "node:test";
import assert from "node:assert/strict";
import { STAGES, TOTAL_KM, dayForDate, progress, positionOnStage, TOWNS } from "../apps/walk/public/route.js";

test("route has 14 stages and sums the table's km", () => {
  assert.equal(STAGES.length, 14);
  assert.equal(TOTAL_KM, 412);
});

test("dayForDate maps Copenhagen dates to stages", () => {
  assert.equal(dayForDate(new Date("2026-10-10T12:00:00Z")), 0);
  assert.equal(dayForDate(new Date("2026-10-12T08:00:00+02:00")), 1);
  assert.equal(dayForDate(new Date("2026-10-11T23:30:00Z")), 1); // 01:30 dansk tid 12/10
  assert.equal(dayForDate(new Date("2026-10-25T12:00:00+01:00")), 14);
  assert.equal(dayForDate(new Date("2026-10-27T12:00:00Z")), 15);
});

test("progress accumulates earlier stages and clamps today's km", () => {
  const p = progress(3, 10);
  assert.equal(p.doneKm, 22 + 30 + 10);
  assert.equal(progress(3, 999).todayKm, 100); // højst 100 km på én dag
  assert.equal(progress(3, 40).todayKm, 40); // må gerne overstige etapens 32 km (tabellen er et estimat)
  assert.equal(progress(3, 40).stagePct, 1); // men baren stopper ved 100 %
  assert.equal(progress(0).doneKm, 0);
  assert.equal(progress(15).doneKm, TOTAL_KM);
});

test("positionOnStage interpolates between towns", () => {
  const s = STAGES[0];
  assert.deepEqual(positionOnStage(s, 0), { lat: TOWNS.rosenholm.lat, lon: TOWNS.rosenholm.lon });
  const end = positionOnStage(s, 1);
  assert.ok(Math.abs(end.lat - TOWNS.aarhus.lat) < 1e-9);
});

import express from "express";
import fs from "node:fs";
import { applyPatch, effectiveState, DEFAULT_STATE } from "../apps/walk/state.js";
import { injectHomeCard } from "../apps/walk/homeCard.js";
import { createWalkApp } from "../apps/walk/app.js";

test("applyPatch validates and clamps panel input", () => {
  const now = new Date("2026-10-13T10:00:00+02:00");
  let s = applyPatch(DEFAULT_STATE, { km: "12.34", variant: "3", visible: false }, now);
  assert.deepEqual([s.km, s.variant, s.visible, s.kmDate], [12.3, "3", false, "2026-10-13"]);
  s = applyPatch(s, { km: 9999, variant: "9", day: "abc", visible: "nej" }, now);
  assert.deepEqual([s.km, s.variant, s.day, s.visible], [100, "3", null, false]);
  assert.equal(applyPatch(s, { day: 7 }).day, 7);
  assert.equal(applyPatch(s, { day: 99 }).day, null);
  assert.equal(applyPatch({ ...s, day: 7 }, { day: "auto" }).day, null);
  assert.equal(applyPatch(s, { km: "" }).km, 100); // tom streng ændrer ikke km
});

test("auto day resets yesterday's km at midnight; manual day keeps them", () => {
  const set = applyPatch(DEFAULT_STATE, { km: 20 }, new Date("2026-10-13T12:00:00+02:00"));
  assert.equal(effectiveState(set, new Date("2026-10-13T23:00:00+02:00")).km, 20);
  assert.equal(effectiveState(set, new Date("2026-10-14T00:30:00+02:00")).km, 0);
  assert.equal(effectiveState({ ...set, day: 2 }, new Date("2026-10-14T00:30:00+02:00")).km, 20);
});

test("home card is injected only via injectHomeCard, never in the static index", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(!/marcel ?walk|walk-/i.test(html), "forsidens kilde må ikke nævne eventet");
  const out = injectHomeCard(html, "/walk-secret123456");
  assert.ok(out.includes('"title":"Marcel Walk"') && out.includes("/walk-secret123456/control.html"));
  assert.ok(out.includes("ICONS.marcelwalk"));
  assert.equal(injectHomeCard("<p>x</p>", "/walk-secret123456"), "<p>x</p>");
});

async function withWalk(password, fn) {
  const old = process.env.WALK_CONTROL_PASSWORD;
  if (password) process.env.WALK_CONTROL_PASSWORD = password; else delete process.env.WALK_CONTROL_PASSWORD;
  delete process.env.DATABASE_URL;
  const app = express();
  app.use("/w", createWalkApp());
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/w`;
  try { await fn(base); } finally { server.close(); if (old === undefined) delete process.env.WALK_CONTROL_PASSWORD; else process.env.WALK_CONTROL_PASSWORD = old; }
}
const post = (url, body, key) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "x-walk-key": key } : {}) }, body: JSON.stringify(body) });

test("control panel API requires the password", async () => {
  await withWalk("hemmelig-kode", async (base) => {
    assert.equal((await post(`${base}/api/state`, { km: 5 })).status, 401);
    assert.equal((await post(`${base}/api/state`, { km: 5 }, "forkert")).status, 401);
    assert.equal((await post(`${base}/api/login`, {}, "hemmelig-kode")).status, 200);
    const ok = await post(`${base}/api/state`, { km: 5, variant: "2" }, "hemmelig-kode");
    assert.equal(ok.status, 200);
    const pub = await (await fetch(`${base}/api/state`)).json(); // overlayet læser uden kode
    assert.deepEqual([pub.km, pub.variant], [5, "2"]);
    assert.ok(!("kmDate" in pub));
    assert.equal((await fetch(`${base}/control.html`)).status, 200);
    assert.match((await fetch(`${base}/api/state`)).headers.get("x-robots-tag"), /noindex/);
  });
});

test("control panel is locked when no password is configured", async () => {
  await withWalk("", async (base) => {
    assert.equal((await post(`${base}/api/state`, { km: 5 })).status, 503);
    assert.equal((await post(`${base}/api/state`, { km: 5 }, "")).status, 503);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).km, 0);
  });
});

test("too many wrong passwords get rate limited", async () => {
  await withWalk("hemmelig-kode", async (base) => {
    for (let i = 0; i < 10; i++) assert.equal((await post(`${base}/api/login`, {}, "nej" + i)).status, 401);
    assert.equal((await post(`${base}/api/login`, {}, "hemmelig-kode")).status, 429);
  });
});

import { FIELDS } from "../apps/walk/public/fields.js";

test("field toggles and title are validated per overlay", () => {
  let s = applyPatch(DEFAULT_STATE, { fields: { 1: { via: false, hack: true }, 9: { x: false }, 2: { title: false } }, title: "  <b>Min tur</b> " });
  assert.deepEqual(s.fields, { 1: { via: false }, 2: { title: false } });
  assert.equal(s.title, "bMin tur/b");
  s = applyPatch(s, { fields: { 1: { via: true, stay: false } } });
  assert.deepEqual(s.fields[1], { via: true, stay: false });
  assert.equal(applyPatch(s, { title: "x".repeat(99) }).title.length, 40);
  assert.deepEqual(applyPatch(s, { fields: { 1: { via: "ja" } } }).fields[1], { via: true, stay: false });
  assert.deepEqual(Object.keys(FIELDS), ["1", "2", "3", "4", "5"]);
  assert.equal(applyPatch(DEFAULT_STATE, { variant: 5 }).variant, "5");
  assert.equal(applyPatch(DEFAULT_STATE, { variant: "6" }).variant, "1");
});

test("fields and title reach the overlay via the public state, after login", async () => {
  await withWalk("hemmelig-kode", async (base) => {
    assert.equal((await post(`${base}/api/state`, { fields: { 3: { labels: false } } })).status, 401);
    await post(`${base}/api/state`, { fields: { 3: { labels: false } }, title: "Marcel Walk" }, "hemmelig-kode");
    const pub = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(pub.fields, { 3: { labels: false } });
    assert.equal(pub.title, "Marcel Walk");
  });
});

import { DK_VIEW, DK_LAND, WORLD_LAND, WORLD_VIEW, dkXY, worldXY } from "../apps/walk/public/geo.js";

test("scale is clamped and survives a bad value", () => {
  assert.equal(applyPatch(DEFAULT_STATE, { scale: 0.65 }).scale, 0.65);
  assert.equal(applyPatch(DEFAULT_STATE, { scale: 99 }).scale, 1.5);
  assert.equal(applyPatch(DEFAULT_STATE, { scale: 0 }).scale, 0.3);
  assert.equal(applyPatch(DEFAULT_STATE, { scale: "abc" }).scale, 1);
  assert.equal(effectiveState(applyPatch(DEFAULT_STATE, { scale: 0.5 })).scale, 0.5);
});

test("every town on the route projects inside the Denmark map, and land data is present", () => {
  for (const t of Object.values(TOWNS)) {
    const [x, y] = dkXY(t.lon, t.lat);
    assert.ok(x > 0 && x < DK_VIEW.w && y > 0 && y < DK_VIEW.h, `${t.name} uden for kortet`);
  }
  assert.ok(DK_LAND.length > 5000);
  const [wx, wy] = worldXY(10.2, 56);
  assert.ok(wx > 0 && wx < WORLD_VIEW.w && wy > 0 && wy < WORLD_VIEW.h);
});

test("world map has no polygon wrapped across the dateline", () => {
  for (const sub of WORLD_LAND.split("M").filter(Boolean)) {
    const xs = sub.replace("Z", "").split("L").map((p) => Number(p.split(" ")[0]));
    assert.ok(Math.max(...xs) - Math.min(...xs) < 700, "polygon strækker sig hen over hele kortet");
  }
});

test("towns sit near their real location (guards against bad coordinates)", () => {
  const near = (k, lat, lon) => { const t = TOWNS[k]; assert.ok(Math.abs(t.lat - lat) < 0.08 && Math.abs(t.lon - lon) < 0.12, k); };
  near("rosenholm", 56.333, 10.325); near("aarup", 55.376, 10.049); near("gavnoe", 55.189, 11.725);
  near("aarhus", 56.157, 10.21); near("odense", 55.40, 10.40); near("herning", 56.139, 8.976);
});

import { paceText, timeText, timerStatus, speedKmh } from "../apps/walk/public/pace.js";
import { restoreState, walkMs } from "../apps/walk/state.js";

test("pace and walking time are formatted in Danish", () => {
  assert.equal(paceText(10, 2 * 3600000), "5,0 km/t");
  assert.equal(paceText(9, 110 * 60000), "4,9 km/t");
  assert.equal(paceText(10, 2 * 3600000, "minkm"), "12:00 min/km");
  assert.equal(paceText(5, 0), "–"); // intet tal før uret har kørt
  assert.equal(paceText(0, 3600000), "–"); // og ikke før der er gået et stykke
  assert.equal(speedKmh(0.01, 600000), null);
  assert.equal(timeText(110 * 60000), "1:50 t");
  assert.equal(timeText(0), "0:00 t");
  assert.deepEqual(["idle", "running", "paused"], [timerStatus({ running: false, ms: 0 }), timerStatus({ running: true, ms: 0 }), timerStatus({ running: false, ms: 5 })]);
});

test("timer: start, pause, resume, adjust, reset", () => {
  const at = (h, m = 0) => new Date(`2026-10-12T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+02:00`);
  let s = applyPatch(DEFAULT_STATE, { timer: "start" }, at(11));
  assert.equal(effectiveState(s, at(12)).timer.ms, 3600000); // uret løber
  s = applyPatch(s, { timer: "pause" }, at(12));
  assert.deepEqual(effectiveState(s, at(14)).timer, { running: false, ms: 3600000 }); // pause: står stille
  s = applyPatch(s, { timer: "start" }, at(14));
  assert.equal(effectiveState(s, at(14, 30)).timer.ms, 3600000 + 1800000);
  assert.equal(applyPatch(s, { timer: "start" }, at(15)).timer.startedAt, s.timer.startedAt); // dobbelt start ændrer intet
  s = applyPatch(s, { timer: "pause" }, at(14, 30));
  assert.equal(applyPatch(s, { timerAddMin: 15 }, at(15)).timer.ms, 5400000 + 900000);
  assert.equal(applyPatch(s, { timerAddMin: -9999 }, at(15)).timer.ms, 0); // aldrig negativ
  assert.equal(applyPatch(s, { timerAddMin: "abc" }, at(15)).timer.ms, 5400000);
  assert.equal(applyPatch(s, { timer: "reset" }, at(15)).timer.ms, 0);
  assert.equal(applyPatch(s, { paceUnit: "minkm" }).paceUnit, "minkm");
  assert.equal(applyPatch(s, { paceUnit: "hack" }).paceUnit, "kmh");
});

test("timer resets at midnight in auto mode, and when the day is changed in the panel", () => {
  let s = applyPatch(DEFAULT_STATE, { timer: "start" }, new Date("2026-10-12T11:00:00+02:00"));
  assert.equal(effectiveState(s, new Date("2026-10-13T00:30:00+02:00")).timer.ms, 0);
  assert.equal(effectiveState({ ...s, day: 3 }, new Date("2026-10-13T00:30:00+02:00")).timer.running, true); // manuel dag: ingen nulstilling
  const changed = applyPatch({ ...s, day: 3 }, { day: 4 }, new Date("2026-10-13T08:00:00+02:00"));
  assert.deepEqual(changed.timer, { running: false, ms: 0, startedAt: null, date: null });
});

test("a restart in the middle of the day keeps the running timer", () => {
  const s = applyPatch(DEFAULT_STATE, { timer: "start", km: 4 }, new Date("2026-10-12T11:00:00+02:00"));
  const restored = restoreState(JSON.parse(JSON.stringify(s)));
  assert.equal(walkMs(restored.timer, new Date("2026-10-12T12:00:00+02:00").getTime()), 3600000);
  assert.equal(restoreState({ timer: { running: true, startedAt: "x", ms: -5 } }).timer.running, false); // ugyldig data
  assert.equal(restoreState({}).timer.ms, 0);
});

test("pace/time/pause toggles exist for every overlay", () => {
  for (const v of ["1", "2", "3", "4", "5"]) assert.ok(FIELDS[v].some(([k]) => k === "pace") && FIELDS[v].some(([k]) => k === "pause"), v);
});

import { etaInfo, shiftClock, isClock, clockText } from "../apps/walk/public/pace.js";

test("expected arrival: automatic from pace, manual override, and edge cases", () => {
  const now = new Date("2026-10-12T14:00:00+02:00").getTime();
  // 10 km på 2 t = 5 km/t, 5 km tilbage -> 1 t -> 15:00
  assert.deepEqual(etaInfo({ remainingKm: 5, ms: 2 * 3600000, kmToday: 10, manual: null, nowMs: now }), { text: "15:00", manual: false });
  assert.deepEqual(etaInfo({ remainingKm: 5, ms: 2 * 3600000, kmToday: 10, manual: "17:30", nowMs: now }), { text: "17:30", manual: true }); // manuel vinder
  assert.equal(etaInfo({ remainingKm: 5, ms: 0, kmToday: 0, manual: null, nowMs: now }).text, "–"); // ingen data endnu
  assert.equal(etaInfo({ remainingKm: 5, ms: 0, kmToday: 0, manual: "18:00", nowMs: now }).text, "18:00"); // men manuel virker alligevel
  assert.equal(etaInfo({ remainingKm: 0, ms: 3600000, kmToday: 10, manual: "18:00", nowMs: now }).text, "Fremme");
  assert.equal(etaInfo({ remainingKm: 5, ms: 3600000, kmToday: 5, manual: "18:00", nowMs: now, walking: false }).text, "–");
  assert.equal(etaInfo({ remainingKm: 5, ms: 3600000, kmToday: 5, manual: "99:99", nowMs: now }).manual, false); // ugyldig sat tid ignoreres
  assert.equal(clockText(new Date("2026-10-12T14:05:00+02:00").getTime()), "14:05");
  assert.equal(shiftClock("23:50", 15), "00:05");
  assert.equal(shiftClock("00:05", -15), "23:50");
  assert.ok(isClock("07:30") && !isClock("7:30") && !isClock("24:00"));
});

test("manual arrival time is validated, expires at midnight and with a day change", () => {
  const day1 = new Date("2026-10-12T15:00:00+02:00");
  let s = applyPatch(DEFAULT_STATE, { eta: "17:30" }, day1);
  assert.equal(effectiveState(s, new Date("2026-10-12T16:00:00+02:00")).eta, "17:30");
  assert.equal(effectiveState(s, new Date("2026-10-13T00:30:00+02:00")).eta, null); // gamle dags tid hænger ikke ved
  assert.equal(effectiveState({ ...s, day: 3 }, new Date("2026-10-13T00:30:00+02:00")).eta, "17:30"); // manuel dag: bliver
  assert.equal(applyPatch(s, { eta: "25:99" }, day1).eta, "17:30"); // ugyldigt ændrer intet
  assert.equal(applyPatch(s, { eta: "auto" }, day1).eta, null);
  assert.equal(applyPatch(s, { eta: null }, day1).eta, null);
  assert.equal(applyPatch({ ...s, day: 3 }, { day: 4 }, day1).eta, null); // ny dag = ny beregning
  assert.equal(restoreState(JSON.parse(JSON.stringify(s))).eta, "17:30");
  assert.equal(restoreState({ eta: "bogus" }).eta, null);
});

test("every overlay can toggle the expected arrival", () => {
  for (const v of ["1", "2", "3", "4", "5"]) assert.ok(FIELDS[v].some(([k]) => k === "eta"), v);
});

test("km counts before the start date too (regression: panel changes had no visible effect)", () => {
  const before = progress(0, 12.5); // Dag = Automatisk, men i dag er før 12/10
  assert.equal(before.state, "before");
  assert.equal(before.todayKm, 12.5);
  assert.equal(before.doneKm, 12.5);
  assert.equal(progress(0, 30).todayKm, 30); // også ud over etapens 22 km
  assert.equal(progress(15, 3).todayKm, STAGES[13].km); // efter målet er den hele etape altid gået
});

import { kmLive } from "../apps/walk/state.js";
import { DEFAULT_SPEED } from "../apps/walk/public/pace.js";

test("km counts up by itself while the clock runs, freezes on pause, and continues from a correction", () => {
  const at = (h, m = 0) => new Date(`2026-10-14T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+02:00`);
  let s = applyPatch(DEFAULT_STATE, { day: 3, speed: 5 }, at(10)); // dag 3 = 32 km, 5 km/t
  assert.equal(effectiveState(s, at(10, 30)).km, 0); // uret er ikke startet
  s = applyPatch(s, { timer: "start" }, at(11));
  assert.equal(effectiveState(s, at(11, 30)).km, 2.5); // 0,5 t × 5 km/t
  assert.equal(effectiveState(s, at(12)).kmRate, 5);
  s = applyPatch(s, { timer: "pause" }, at(12));
  const paused = effectiveState(s, at(15));
  assert.deepEqual([paused.km, paused.kmRate], [5, 0]); // pause: km står stille
  s = applyPatch(s, { km: 4.2 }, at(15)); // ret: han holdt pause og uret stod ikke stille
  s = applyPatch(s, { timer: "start" }, at(15));
  assert.equal(effectiveState(s, at(16)).km, 9.2); // 4,2 + 1 t × 5
  s = applyPatch(s, { speed: 4 }, at(16)); // nyt tempo: intet hop
  assert.equal(effectiveState(s, at(16)).km, 9.2);
  assert.equal(effectiveState(s, at(17)).km, 13.2);
  assert.equal(effectiveState(s, at(23)).km, 32); // stopper ved etapens planlagte km
  assert.equal(effectiveState(s, at(23)).kmRate, 0);
});

test("a correction above the planned km is kept, and auto-count can be switched off", () => {
  const at = (h) => new Date(`2026-10-14T${String(h).padStart(2, "0")}:00:00+02:00`);
  let s = applyPatch(applyPatch(DEFAULT_STATE, { day: 3, speed: 5 }, at(9)), { timer: "start" }, at(9));
  s = applyPatch(s, { km: 35 }, at(10)); // ruten blev længere end de 32 km i tabellen
  assert.equal(effectiveState(s, at(12)).km, 35); // optællingen går ikke længere end det, du selv har sat
  s = applyPatch(DEFAULT_STATE, { day: 3, speed: 5 }, at(9));
  s = applyPatch(s, { timer: "start" }, at(9));
  s = applyPatch(s, { kmAuto: false }, at(10)); // holder de 5 optalte km fast
  assert.equal(effectiveState(s, at(14)).km, 5);
  assert.equal(effectiveState(s, at(14)).kmRate, 0);
  s = applyPatch(s, { kmAuto: true }, at(14));
  assert.equal(effectiveState(s, at(15)).km, 10); // 5 + 1 t
});

test("speed is validated, and day change or timer reset do not make km jump", () => {
  const at = (h) => new Date(`2026-10-14T${String(h).padStart(2, "0")}:00:00+02:00`);
  assert.equal(applyPatch(DEFAULT_STATE, { speed: 99 }, at(9)).speed, 12);
  assert.equal(applyPatch(DEFAULT_STATE, { speed: 0.1 }, at(9)).speed, 1);
  assert.equal(applyPatch(DEFAULT_STATE, { speed: "abc" }, at(9)).speed, DEFAULT_SPEED);
  let s = applyPatch(applyPatch(DEFAULT_STATE, { day: 3, speed: 5 }, at(9)), { timer: "start" }, at(9));
  const r = applyPatch(s, { timer: "reset" }, at(11)); // 2 t gået = 10 km; nulstilling af uret må ikke fjerne dem
  assert.equal(effectiveState(r, at(11)).km, 10);
  assert.equal(effectiveState(r, at(12)).km, 10); // uret står stille igen
  const d = applyPatch(s, { day: 4, km: 0 }, at(11)); // dagsskifte fra panelet
  assert.deepEqual([effectiveState(d, at(11)).km, d.timer.ms], [0, 0]);
});

test("auto-count and speed survive a restart, and yesterday's count is cleared at midnight", () => {
  const at = (d, h) => new Date(`2026-10-${d}T${String(h).padStart(2, "0")}:00:00+02:00`);
  let s = applyPatch(applyPatch(DEFAULT_STATE, { timer: "start", speed: 4 }, at(14, 9)), { km: 2 }, at(14, 10));
  const back = restoreState(JSON.parse(JSON.stringify(s)));
  assert.equal(effectiveState(back, at(14, 12)).km, 2 + 2 * 4);
  assert.equal(effectiveState(s, at(15, 1)).km, 0); // ny dag i automatisk tilstand
  assert.equal(restoreState({ speed: "x", kmAnchorMs: -5, kmAuto: undefined }).speed, DEFAULT_SPEED);
  assert.equal(kmLive(restoreState({}), at(14, 9)).km, 0);
});

test("default tempo is 4.5 km/t from the start, and a saved tempo is kept", () => {
  const at = (h) => new Date(`2026-10-14T${String(h).padStart(2, "0")}:00:00+02:00`);
  assert.equal(DEFAULT_SPEED, 4.5);
  assert.equal(effectiveState(DEFAULT_STATE, at(9)).speed, 4.5);
  let s = applyPatch(applyPatch(DEFAULT_STATE, { day: 3 }, at(9)), { timer: "start" }, at(9));
  assert.equal(effectiveState(s, at(11)).km, 9); // 2 t × 4,5 km/t
  assert.equal(effectiveState(s, at(11)).kmRate, 4.5);
  assert.equal(restoreState({}).speed, 4.5);
  assert.equal(restoreState({ speed: 5 }).speed, 5); // et tempo du selv har sat (eller som er gemt) bevares
});

import { pathUpTo } from "../apps/walk/public/route.js";

test("pathUpTo draws the walked part of a stage, growing with the fraction", () => {
  const s = STAGES[6]; // dag 7: Brande -> Give -> Jelling
  assert.equal(pathUpTo(s, 0).length, 2); // kun startpunktet (to ens punkter)
  const half = pathUpTo(s, 0.5);
  const full = pathUpTo(s, 1);
  assert.deepEqual(full.at(-1), { lat: TOWNS.jelling.lat, lon: TOWNS.jelling.lon }); // ender i målet
  assert.ok(full.some((p) => p.lat === TOWNS.give.lat && p.lon === TOWNS.give.lon)); // og går via Give
  assert.ok(half.length <= full.length);
  const len = (pts) => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p.lat - pts[i].lat, (p.lon - pts[i].lon) * 0.56), 0);
  assert.ok(len(pathUpTo(s, 0.25)) < len(half) && len(half) < len(pathUpTo(s, 0.75)) && len(pathUpTo(s, 0.75)) < len(full));
  assert.ok(Math.abs(len(half) - len(full) / 2) < 1e-9); // 50 % af km = 50 % af stien
  assert.deepEqual(positionOnStage(s, 0.5), half.at(-1)); // prikken sidder for enden af sporet
  assert.deepEqual(pathUpTo(s, 7).at(-1), full.at(-1)); // fraction klemmes
  assert.deepEqual(pathUpTo(s, -1)[0], { lat: TOWNS.brande.lat, lon: TOWNS.brande.lon });
});

test("overlays 3 and 5 can switch between the whole route and a zoom on today's stage", () => {
  for (const v of ["3", "5"]) assert.ok(FIELDS[v].some(([k]) => k === "overview"), v);
  assert.equal(applyPatch(DEFAULT_STATE, { fields: { 5: { overview: false } } }).fields[5].overview, false);
  assert.deepEqual(applyPatch(DEFAULT_STATE, { fields: { 1: { overview: false } } }).fields[1] ?? {}, {}); // findes kun på de to kort-overlays
});

import { LOOKS } from "../apps/walk/public/fields.js";

test("the overlay look (theme) and brightness can be switched and are validated", () => {
  assert.deepEqual(LOOKS.map(([k]) => k), ["nu", "mg"]);
  assert.equal(DEFAULT_STATE.look, "nu");
  assert.equal(applyPatch(DEFAULT_STATE, { look: "mg" }).look, "mg");
  assert.equal(applyPatch(DEFAULT_STATE, { look: "hack" }).look, "nu"); // ukendt tema ignoreres
  assert.equal(applyPatch({ ...DEFAULT_STATE, look: "mg" }, { look: 5 }).look, "mg");
  assert.equal(applyPatch(DEFAULT_STATE, { brightness: 0.6 }).brightness, 0.6);
  assert.equal(applyPatch(DEFAULT_STATE, { brightness: 9 }).brightness, 1);
  assert.equal(applyPatch(DEFAULT_STATE, { brightness: 0 }).brightness, 0.3);
  assert.equal(applyPatch(DEFAULT_STATE, { brightness: "abc" }).brightness, 1);
  const e = effectiveState(applyPatch(DEFAULT_STATE, { look: "mg", brightness: 0.7 }));
  assert.deepEqual([e.look, e.brightness], ["mg", 0.7]);
  const back = restoreState(JSON.parse(JSON.stringify(applyPatch(DEFAULT_STATE, { look: "mg", brightness: 0.7 }))));
  assert.deepEqual([back.look, back.brightness], ["mg", 0.7]); // gemmes og huskes efter genstart
  assert.equal(restoreState({ look: "weird" }).look, "nu");
});
