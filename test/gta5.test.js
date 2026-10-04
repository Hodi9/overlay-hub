import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.GTA5_TRACKER_KEY = "test-tracker-key";
process.env.GTA5_CONTROL_PASSWORD = "test-control-pw";
delete process.env.DATABASE_URL;

const { createGta5App, migrateSavedList } = await import("../apps/gta5/app.js");
const { DEFAULT_MISSIONS } = await import("../apps/gta5/missions.js");

const YOGA = "Did Somebody Say Yoga?";
const REQUIRED = DEFAULT_MISSIONS.filter((m) => !m.optional);

async function withServer(fn) {
  const app = express();
  app.use("/gta5", createGta5App());
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/gta5`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendCapture(base, text, profile) {
  return fetch(`${base}/api/tracker?profile=${profile}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-tracker-key" },
    body: JSON.stringify({ text, percent: 19.4 })
  }).then((r) => r.json());
}

function getState(base, profile) {
  return fetch(`${base}/api/state?profile=${profile}`).then((r) => r.json());
}

function control(base, profile, method, route, body) {
  return fetch(`${base}${route}?profile=${profile}`, {
    method,
    headers: { "Content-Type": "application/json", "x-gta5-key": "test-control-pw" },
    body: body ? JSON.stringify(body) : undefined
  }).then((r) => r.json());
}

test("tracker matches a mission far into the list even when nothing is done yet", async () => {
  await withServer(async (base) => {
    const result = await sendCapture(base, YOGA, "t1");
    assert.equal(result.matched, true);
    assert.equal(result.matchedChapter.day, YOGA);
    assert.equal(result.progress.completed, 1);
    assert.equal(result.progress.total, REQUIRED.length);

    const state = await getState(base, "t1");
    const yogaIndex = state.chapters.findIndex((c) => c.day === YOGA);
    assert.deepEqual(state.completed, [yogaIndex]);
    assert.equal(state.lastCompleted.day, YOGA);
    assert.equal(state.chapters[yogaIndex].done, true);
    assert.equal(state.chapters[0].done, false);
  });
});

test("tracker reports no match for unknown titles and keeps progress", async () => {
  await withServer(async (base) => {
    const result = await sendCapture(base, "Some Stranger Mission", "t2");
    assert.equal(result.matched, false);
    assert.equal(result.progress.completed, 0);
  });
});

test("tracker rejects a wrong key", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/tracker`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: JSON.stringify({ text: "Chop" })
    });
    assert.equal(response.status, 401);
  });
});

test("every default mission title matches its own row", async () => {
  await withServer(async (base) => {
    for (const [i, mission] of DEFAULT_MISSIONS.entries()) {
      const profile = `self${i}`;
      const result = await sendCapture(base, mission.name, profile);
      assert.equal(result.matched, true, `${mission.name} should match`);
      assert.equal(result.matchedChapter.day, mission.name, `${mission.name} matched the wrong row`);
    }
  });
});

test("save titles with a suffix still match (e.g. Gauntlet 2 -> Gauntlet)", async () => {
  await withServer(async (base) => {
    const result = await sendCapture(base, "Gauntlet 2", "t6");
    assert.equal(result.matched, true);
    assert.equal(result.matchedChapter.day, "Gauntlet");
  });
});

test("optional missions are ticked off but do not count toward the percentage", async () => {
  await withServer(async (base) => {
    const result = await sendCapture(base, "Carbine Rifles", "t7");
    assert.equal(result.matched, true);
    assert.equal(result.progress.completed, 0);
    assert.equal(result.progress.optionalCompleted, 1);

    const state = await getState(base, "t7");
    assert.equal(state.percent, 0);
    assert.equal(state.chapters.find((c) => c.day === "Carbine Rifles").done, true);
    assert.equal(state.chapters.find((c) => c.day === "Carbine Rifles").optional, true);

    await sendCapture(base, "Chop", "t7");
    const after = await getState(base, "t7");
    assert.equal(after.progress.completed, 1);
    assert.equal(after.percent, Math.round((1 / REQUIRED.length) * 1000) / 10);
  });
});

test("through=true fills in every required mission before the index, skipping optional ones", async () => {
  await withServer(async (base) => {
    await sendCapture(base, YOGA, "t3");
    const before = await getState(base, "t3");
    const yogaIndex = before.chapters.findIndex((c) => c.day === YOGA);
    const state = await control(base, "t3", "PATCH", "/api/current", { index: yogaIndex, done: true, through: true });

    const requiredThroughYoga = before.chapters.filter((c, i) => i <= yogaIndex && !c.optional).length;
    assert.equal(state.progress.completed, requiredThroughYoga);
    assert.equal(state.progress.optionalCompleted, 0);
    assert.equal(state.lastCompletedIndex, yogaIndex);
    assert.equal(state.percent, Math.round((requiredThroughYoga / state.progress.total) * 1000) / 10);
  });
});

test("finishing everything reaches 100% without any optional missions", async () => {
  await withServer(async (base) => {
    const before = await getState(base, "t8");
    const state = await control(base, "t8", "PATCH", "/api/current", {
      index: before.chapters.length - 1,
      done: true,
      through: true
    });
    assert.equal(state.finished, true);
    assert.equal(state.percent, 100);
    assert.equal(state.progress.optionalCompleted, 0);
  });
});

test("removing a mission keeps checkmarks on the right missions", async () => {
  await withServer(async (base) => {
    await sendCapture(base, YOGA, "t4");
    const before = await getState(base, "t4");
    const yogaIndex = before.chapters.findIndex((c) => c.day === YOGA);
    const chapters = before.chapters.slice();
    chapters.splice(3, 1);
    const after = await control(base, "t4", "PUT", "/api/chapters", { chapters });
    assert.equal(after.chapters.length, before.chapters.length - 1);
    assert.deepEqual(after.completed, [yogaIndex - 1]);
    assert.equal(after.lastCompleted.day, YOGA);
  });
});

test("control endpoints require the password", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reset?profile=t5`, { method: "POST" });
    assert.equal(response.status, 401);
  });
});

// Mirrors a live list from before heist preps were added: the 56 old
// required rows, plus the same mission added twice via "Tilføj som ny mission".
function oldSavedList() {
  const base = REQUIRED.map((m, i) => ({ id: `old-${i}`, day: m.name, location: "", part: m.character, optional: false }));
  base.push({ id: "dup-1", day: YOGA, location: "", part: null, optional: false });
  base.push({ id: "dup-2", day: YOGA, location: "", part: null, optional: false });
  return base;
}

test("migration removes duplicates and adds missing defaults without moving checkmarks", () => {
  const chapters = oldSavedList();
  const yogaOld = chapters.findIndex((c) => c.day === YOGA);
  const completed = new Set(Array.from({ length: yogaOld }, (_, i) => i)); // everything before Yoga
  completed.add(chapters.length - 1); // the second duplicate was ticked off
  const lastCompletedIndex = chapters.length - 1;

  const result = migrateSavedList(chapters, completed, lastCompletedIndex);

  assert.equal(result.chapters.filter((c) => c.day === YOGA).length, 1);
  assert.equal(result.chapters.length, DEFAULT_MISSIONS.length);
  assert.deepEqual(
    result.chapters.map((c) => c.day),
    DEFAULT_MISSIONS.map((m) => m.name)
  );

  const doneNames = new Set(Array.from(result.completed).map((i) => result.chapters[i].day));
  for (let i = 0; i < yogaOld; i++) assert.ok(doneNames.has(chapters[i].day), `${chapters[i].day} should stay done`);
  assert.ok(doneNames.has(YOGA), "tick on the removed duplicate moves to the kept Yoga row");
  assert.equal(result.chapters[result.lastCompletedIndex].day, YOGA);

  const optionalNames = DEFAULT_MISSIONS.filter((m) => m.optional).map((m) => m.name);
  for (const name of optionalNames) {
    const row = result.chapters.find((c) => c.day === name);
    assert.equal(row.optional, true, `${name} should be optional`);
    assert.equal(doneNames.has(name), false, `${name} should not be ticked`);
  }
});

test("migration keeps the user's custom missions and order", () => {
  const chapters = oldSavedList().slice(0, REQUIRED.length);
  chapters.splice(10, 0, { id: "mine", day: "Grass Roots", location: "", part: "michael", optional: false });
  const result = migrateSavedList(chapters, new Set(), -1);
  const names = result.chapters.map((c) => c.day);
  assert.ok(names.includes("Grass Roots"));
  assert.equal(names.length, DEFAULT_MISSIONS.length + 1);
  assert.ok(names.indexOf("The Good Husband") < names.indexOf("Casing the Jewel Store"));
  assert.ok(names.indexOf("Casing the Jewel Store") < names.indexOf("Carbine Rifles"));
  assert.ok(names.indexOf("Carbine Rifles") < names.indexOf("The Jewel Store Job"));
});
