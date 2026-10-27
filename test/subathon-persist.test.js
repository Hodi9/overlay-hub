import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import tmi from "tmi.js";
import { createSubathonApp } from "../apps/subathon/app.js";
import { createChannelRegistry } from "../apps/_lib/channels.js";

// The subathon saves its state in Postgres when there is a database, and a restart must pick it up
// again: the counter, the goals, the settings and a timer that is still running. This stands in
// for the database with a table in memory, and for a restart with a second app on the same table.
delete process.env.DATABASE_URL;
delete process.env.SUBATHON_CONTROL_PASSWORD;
delete process.env.SUBATHON_TWITCH_CHANNEL;

const joined = [];
tmi.Client.prototype.connect = async function () { return ["irc-ws.chat.twitch.tv", 443]; };
tmi.Client.prototype.join = async function (channel) { joined.push(channel); return [channel]; };

const T0 = 1_700_000_000_000;
const table = new Map();
const database = { insertDelays: [], failInserts: false, inserts: 0 };
const pool = {
  async query(sql, params = []) {
    if (/CREATE TABLE/i.test(sql)) return { rows: [] };
    if (/INSERT INTO subathon_state/i.test(sql)) {
      const delay = database.insertDelays.shift() || 0;
      database.inserts += 1;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (database.failInserts) throw new Error("simulated database failure");
      table.set(params[0], JSON.parse(params[1]));
      return { rows: [] };
    }
    if (/SELECT data FROM subathon_state WHERE id/i.test(sql)) {
      return { rows: table.has(params[0]) ? [{ data: structuredClone(table.get(params[0])) }] : [] };
    }
    if (/SELECT id FROM subathon_state/i.test(sql)) {
      const running = [...table].filter(([id, data]) => id !== params[0] && ["running", "paused"].includes(data.timer?.status));
      return { rows: running.map(([id]) => ({ id })) };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
};

const servers = [];
async function start({ clock, channels = null }) {
  const app = express();
  app.use("/subathon", createSubathonApp({ channels, pool, now: () => clock.t }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/subathon/api`;
  const call = async (path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { call };
}
test.after(() => { for (const server of servers) { server.closeAllConnections?.(); server.close(); } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

test("counter, goals, settings and a running timer survive a restart", async () => {
  const clock = { t: T0 };
  const before = await start({ clock });
  await before.call("/settings", { secondsPerSub: { t1: 45 } });
  await before.call("/goals", { goals: [{ title: "Persisted goal", target: 12 }] });
  await before.call("/timer/start", {});
  await before.call("/simulate", { kind: "sub", tier: 1 });
  await before.call("/simulate", { kind: "sub", tier: 1 });
  assert.equal(table.get("main").count, 2);

  clock.t += 10_000; // the server was away for ten seconds
  const after = await start({ clock });
  const { body } = await after.call("/state");
  assert.equal(body.count, 2);
  assert.deepEqual(body.settings.secondsPerSub, { t1: 45, t2: 40, t3: 100 });
  assert.deepEqual(body.goals.map((g) => [g.title, g.target]), [["Persisted goal", 12]]);
  assert.equal(body.timer.status, "running");
  assert.equal(body.timer.remainingMs, 3_600_000 + 90_000 - 10_000);
  assert.equal(body.timer.addedMs, 90_000);
  assert.equal(body.events.length, 2);
});

test("after a restart the chats of subathons in progress are joined without anybody opening a page", async () => {
  const clock = { t: T0 };
  const first = await start({ clock });
  await first.call("/twitch", { twitch: "persistedmain" });
  await first.call("/timer/start", {});

  const registry = createChannelRegistry();
  const running = await registry.create({ twitch: "hubrunning" });
  const idle = await registry.create({ twitch: "hubidle" });
  const withHub = await start({ clock, channels: registry });
  await withHub.call(`/timer/start?profile=${running.id}`, {}, { "x-channel-key": running.ownerKey });
  await withHub.call(`/settings?profile=${idle.id}`, { startSeconds: 600 }, { "x-channel-key": idle.ownerKey });
  assert.equal(table.get(`hub:${running.id}`).timer.status, "running");
  assert.equal(table.get(`hub:${idle.id}`).timer.status, "idle");

  joined.length = 0;
  await start({ clock, channels: registry }); // the restart
  await settle();
  assert.ok(joined.includes("persistedmain"), "the main subathon's chat");
  assert.ok(joined.includes("hubrunning"), "a channel whose timer is running");
  assert.ok(!joined.includes("hubidle"), "a channel that has not started is left alone until somebody opens it");
});

test("a slow save never lands after a newer one", async () => {
  const clock = { t: T0 };
  const app = await start({ clock });
  await app.call("/reset", { what: "all" });
  database.insertDelays = [250];
  const slow = app.call("/simulate", { kind: "sub", tier: 1 });
  await settle();
  const fast = app.call("/simulate", { kind: "sub", tier: 1 });
  await Promise.all([slow, fast]);
  assert.equal(table.get("main").count, 2);
});

test("a failing save is reported to the panel, but the sub is not lost from the live state", async () => {
  const clock = { t: T0 };
  const app = await start({ clock });
  await app.call("/reset", { what: "all" });
  database.failInserts = true;
  const failed = await app.call("/simulate", { kind: "sub", tier: 1 });
  assert.equal(failed.status, 500);
  database.failInserts = false;
  assert.equal((await app.call("/state")).body.count, 1);
  const next = await app.call("/simulate", { kind: "sub", tier: 1 });
  assert.equal(next.status, 200);
  assert.equal(table.get("main").count, 2); // the next save carries everything
});
