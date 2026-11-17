import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createGauntletApp } from "../apps/gauntlet/app.js";

async function serve() {
  const app = express();
  app.use("/gauntlet", createGauntletApp());
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/gauntlet/api`;
  const call = async (path, method = "GET", body) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { call, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test("completing the game being played moves the frame on, and a reset counts up and takes every check mark off", async () => {
  const { call, close } = await serve();
  try {
    let { data } = await call("/state");
    const [first, second, third] = data.games;
    // Nothing picked yet: the first game is the one being played.
    assert.deepEqual([data.resets, data.showResets, data.current], [0, true, first.id]);

    ({ data } = await call("/run", "PATCH", { current: first.id }));
    assert.equal(data.current, first.id);
    ({ data } = await call(`/games/${first.id}`, "PATCH", { done: true }));
    assert.deepEqual([data.games[0].done, data.current], [true, second.id]);
    // Hiding the next game skips it; completing a game that is not being played leaves the frame alone.
    ({ data } = await call(`/games/${second.id}`, "PATCH", { visible: false }));
    assert.equal(data.current, third.id);
    ({ data } = await call(`/games/${data.games[4].id}`, "PATCH", { done: true }));
    assert.equal(data.current, third.id);

    ({ data } = await call("/reset", "POST", {}));
    assert.deepEqual([data.resets, data.games.some((g) => g.done), data.current], [1, false, first.id]);
    // Deaths are kept through a reset.
    await call(`/games/${first.id}`, "PATCH", { deaths: 4 });
    ({ data } = await call("/reset", "POST", {}));
    assert.deepEqual([data.resets, data.games[0].deaths], [2, 4]);

    ({ data } = await call("/run", "PATCH", { resets: -5, showResets: false, current: "findes-ikke" }));
    assert.deepEqual([data.resets, data.showResets, data.current], [0, false, first.id]);

    // The win ("Gaming Gauntlet Champions") is off until it is switched on; another change leaves it alone, a reset ends it.
    assert.deepEqual([data.champions, "cover" in data], [false, false]);
    ({ data } = await call("/run", "PATCH", { champions: true }));
    assert.equal(data.champions, true);
    ({ data } = await call("/run", "PATCH", { showResets: false }));
    assert.equal(data.champions, true);
    ({ data } = await call("/run", "PATCH", { champions: false }));
    assert.equal(data.champions, false);
    ({ data } = await call("/run", "PATCH", { champions: true }));
    ({ data } = await call("/reset", "POST", {}));
    assert.deepEqual([data.champions, data.games.length], [false, 7]);

    // The record: no game until one is picked; a newly picked game starts at one time, and a reset leaves it alone.
    assert.deepEqual([data.best, data.bestCount], ["", 0]);
    ({ data } = await call("/run", "PATCH", { best: third.id }));
    assert.deepEqual([data.best, data.bestCount], [third.id, 1]);
    ({ data } = await call("/run", "PATCH", { bestCount: 3 }));
    ({ data } = await call("/reset", "POST", {}));
    assert.deepEqual([data.best, data.bestCount], [third.id, 3]);
    ({ data } = await call("/run", "PATCH", { best: data.games[3].id }));
    assert.deepEqual([data.best, data.bestCount], [data.games[3].id, 1]);
    // It can be hidden on the overlay without being forgotten.
    assert.equal(data.showBest, true);
    ({ data } = await call("/run", "PATCH", { showBest: false }));
    assert.deepEqual([data.showBest, data.best, data.bestCount, typeof data.version], [false, data.games[3].id, 1, "string"]);
    ({ data } = await call("/run", "PATCH", { best: "findes-ikke" }));
    assert.equal(data.best, "");
    ({ data } = await call("/run", "PATCH", { best: "" }));
    assert.deepEqual([data.best, data.bestCount], ["", 0]);
  } finally {
    await close();
  }
});
