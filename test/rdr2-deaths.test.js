import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pg from "pg";
import tmi from "tmi.js";
import { createRdr2DeathsApp } from "../apps/rdr2-deaths/app.js";

// A death (from the panel or "!died" in chat) updates the in-memory count first.
// Live viewers must hear about it right away even when the database write is slow
// or fails — otherwise the counter on stream lags until the page is refreshed.
// node --test runs each file in its own process, so patching pg and tmi.js here
// does not leak into other tests.
let database = { delay: 0, fail: false };
pg.Pool.prototype.query = async function () {
  if (database.delay) await new Promise((resolve) => setTimeout(resolve, database.delay));
  if (database.fail) throw new Error("simulated database failure");
  return { rows: [] };
};
process.env.DATABASE_URL = "postgres://fake:fake@localhost/fake";

// Opening the counter normally joins the channel's real Twitch chat.
tmi.Client.prototype.connect = async function () { return ["irc-ws.chat.twitch.tv", 443]; };
tmi.Client.prototype.join = async function (channel) { return [channel]; };

const app = express();
app.use("/t", createRdr2DeathsApp());
const server = http.createServer(app).listen(0);
const base = () => `http://127.0.0.1:${server.address().port}/t`;
test.after(() => { server.closeAllConnections?.(); server.close(); });

// Opens the live stream (which also loads the channel) and resolves with the time
// the next state with the given count arrives.
async function watchFor(count, channel) {
  const controller = new AbortController();
  const response = await fetch(`${base()}/api/events?channel=${channel}`, { signal: controller.signal });
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
        if (message.startsWith("data:") && JSON.parse(message.slice(5)).count === count) return Date.now();
      }
    }
  })();
  return { arrived, stop: () => controller.abort() };
}

const addDeath = (channel) => fetch(`${base()}/api/increment?channel=${channel}`, { method: "POST" });

test("live viewers see the new death count at once when the database write is slow", async () => {
  database = { delay: 600, fail: false };
  const watcher = await watchFor(1, "slowchan");
  const started = Date.now();
  const response = await addDeath("slowchan");
  const answeredAt = Date.now();
  const heardAt = await watcher.arrived;
  watcher.stop();

  assert.equal(response.status, 200);
  assert.ok(answeredAt - started >= 500, "the click itself still waits for the save");
  assert.ok(heardAt - started < 300, `viewers heard after ${heardAt - started}ms, expected well before the 600ms save`);
});

test("live viewers see the new death count even when the database write fails, and the click reports the failure", async () => {
  database = { delay: 0, fail: true };
  const watcher = await watchFor(1, "failchan");
  const response = await addDeath("failchan");
  const heardAt = await Promise.race([watcher.arrived, new Promise((resolve) => setTimeout(() => resolve(null), 1500))]);
  watcher.stop();

  assert.equal(response.status, 500);
  assert.notEqual(heardAt, null, "viewers were never told about the death");
});
