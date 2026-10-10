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
  assert.equal(progress(3, 999).todayKm, 32);
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
