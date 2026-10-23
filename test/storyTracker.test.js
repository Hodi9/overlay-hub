import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pg from "pg";
import { createStoryTrackerApp } from "../apps/_lib/storyTracker.js";

// Every control change updates the in-memory state first. Live viewers (the
// overlay, control panels) must hear about it right away even when the database
// write is slow or fails — otherwise a click looks dead until the page is
// refreshed. node --test runs each file in its own process, so patching the
// pg pool here does not leak into other tests.
let database = { delay: 0, fail: false };
pg.Pool.prototype.query = async function () {
  if (database.delay) await new Promise((resolve) => setTimeout(resolve, database.delay));
  if (database.fail) throw new Error("simulated database failure");
  return { rows: [] };
};
process.env.DATABASE_URL = "postgres://fake:fake@localhost/fake";

const chapter = (input) => ({ id: input.id || String(input.day), day: String(input.day || ""), location: "", part: null });
const router = createStoryTrackerApp({
  publicDir: ".",
  envPrefix: "STORYTEST",
  dbTable: "storytest_state",
  defaultChapters: [{ day: "one" }, { day: "two" }, { day: "three" }],
  cleanChapter: chapter,
  matchText: (c) => c.day
});
const app = express();
app.use("/t", router);
const server = http.createServer(app).listen(0);
const base = () => `http://127.0.0.1:${server.address().port}/t`;
test.after(() => { server.closeAllConnections?.(); server.close(); });

// Opens the live stream and resolves with the time the next state with currentIndex === index arrives.
async function watchFor(index, profile) {
  const controller = new AbortController();
  const response = await fetch(`${base()}/api/events?profile=${profile}`, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const arrived = (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value);
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (message.startsWith("data:") && JSON.parse(message.slice(5)).currentIndex === index) return Date.now();
      }
    }
  })();
  return { arrived, stop: () => controller.abort() };
}

const patchCurrent = (index, profile) =>
  fetch(`${base()}/api/current?profile=${profile}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index })
  });

test("live viewers are told at once when the database write is slow", async () => {
  database = { delay: 600, fail: false };
  const watcher = await watchFor(2, "slow");
  const started = Date.now();
  const response = await patchCurrent(2, "slow");
  const answeredAt = Date.now();
  const heardAt = await watcher.arrived;
  watcher.stop();

  assert.equal(response.status, 200);
  assert.ok(answeredAt - started >= 500, "the click itself still waits for the save");
  assert.ok(heardAt - started < 300, `viewers heard after ${heardAt - started}ms, expected well before the 600ms save`);
});

test("live viewers are told even when the database write fails, and the click reports the failure", async () => {
  database = { delay: 0, fail: true };
  const watcher = await watchFor(1, "failing");
  const response = await patchCurrent(1, "failing");
  const heardAt = await Promise.race([watcher.arrived, new Promise((resolve) => setTimeout(() => resolve(null), 1500))]);
  watcher.stop();

  assert.equal(response.status, 500);
  assert.notEqual(heardAt, null, "viewers were never told about the change");
});
