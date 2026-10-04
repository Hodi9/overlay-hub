import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.GTA5_TRACKER_KEY = "test-tracker-key";
process.env.GTA5_CONTROL_PASSWORD = "test-control-pw";
delete process.env.DATABASE_URL;

const { createGta5App } = await import("../apps/gta5/app.js");

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

function control(base, profile, method, route, body) {
  return fetch(`${base}${route}?profile=${profile}`, {
    method,
    headers: { "Content-Type": "application/json", "x-gta5-key": "test-control-pw" },
    body: body ? JSON.stringify(body) : undefined
  }).then((r) => r.json());
}

test("tracker matches a mission far into the list even when nothing is done yet", async () => {
  await withServer(async (base) => {
    const result = await sendCapture(base, "Did Somebody Say Yoga?", "t1");
    assert.equal(result.matched, true);
    assert.equal(result.matchedChapter.day, "Did Somebody Say Yoga?");
    assert.equal(result.progress.completed, 1);

    const state = await fetch(`${base}/api/state?profile=t1`).then((r) => r.json());
    assert.deepEqual(state.completed, [24]);
    assert.equal(state.lastCompleted.day, "Did Somebody Say Yoga?");
    assert.equal(state.chapters[24].done, true);
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

test("through=true fills in every mission up to and including the index", async () => {
  await withServer(async (base) => {
    await sendCapture(base, "Did Somebody Say Yoga?", "t3");
    const state = await control(base, "t3", "PATCH", "/api/current", { index: 24, done: true, through: true });
    assert.equal(state.progress.completed, 25);
    assert.equal(state.lastCompletedIndex, 24);
    assert.equal(state.percent, Math.round((25 / state.progress.total) * 1000) / 10);
  });
});

test("removing a mission keeps checkmarks on the right missions", async () => {
  await withServer(async (base) => {
    await sendCapture(base, "Did Somebody Say Yoga?", "t4");
    const before = await fetch(`${base}/api/state?profile=t4`).then((r) => r.json());
    const chapters = before.chapters.slice();
    chapters.splice(3, 1);
    const after = await control(base, "t4", "PUT", "/api/chapters", { chapters });
    assert.equal(after.chapters.length, before.chapters.length - 1);
    assert.deepEqual(after.completed, [23]);
    assert.equal(after.lastCompleted.day, "Did Somebody Say Yoga?");
  });
});

test("control endpoints require the password", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reset?profile=t5`, { method: "POST" });
    assert.equal(response.status, 401);
  });
});
