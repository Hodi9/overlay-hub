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

    // The cover ("Får jeg løn?") is off until it is switched on, and a reset or another change leaves it alone.
    assert.equal(data.cover, false);
    ({ data } = await call("/run", "PATCH", { cover: true }));
    assert.equal(data.cover, true);
    ({ data } = await call("/reset", "POST", {}));
    assert.deepEqual([data.cover, data.games.length], [true, 7]);
    ({ data } = await call("/run", "PATCH", { cover: false }));
    assert.equal(data.cover, false);
  } finally {
    await close();
  }
});
