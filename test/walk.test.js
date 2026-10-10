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
