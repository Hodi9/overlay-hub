import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

delete process.env.GTA6COUNTERS_CONTROL_PASSWORD;
delete process.env.GTA6COUNTERS_TWITCH_CHANNEL;

const { MAX_COUNT, bump, cleanChannel, cleanCommand, commandTaken, counterForCommand, defaultState, editCounter, makeCounter, reorder, restore } = await import("../apps/gta6counters/state.js");
const { CHAT_COOLDOWN_MS, createGta6CountersApp } = await import("../apps/gta6counters/app.js");

test("starts with the three GTA VI counters at 0 and chat off", () => {
  const s = defaultState();
  assert.deepEqual(s.counters.map((c) => [c.label, c.command, c.count, c.visible]), [
    ["Dødsfald", "!death", 0, true],
    ["Stripklub", "!strip", 0, true],
    ["Lucia sex", "!lucia", 0, true]
  ]);
  assert.equal(s.channel, "");
});

test("commands get a ! and must be one short word; channels are cleaned", () => {
  assert.equal(cleanCommand("death"), "!death");
  assert.equal(cleanCommand(" !DØD "), "!død");
  assert.equal(cleanCommand(""), "");
  assert.equal(cleanCommand("!two words"), null);
  assert.equal(cleanChannel("https://twitch.tv/WendelboLOL"), "wendelbolol");
  assert.equal(cleanChannel(""), "");
  assert.equal(cleanChannel("x y"), null);
});

test("counts never go below 0 or above the maximum", () => {
  const c = makeCounter({ label: "Dødsfald" });
  assert.equal(bump(c, -1).count, 0);
  assert.equal(bump(bump(c, 1), 1).count, 2);
  assert.equal(bump({ ...c, count: MAX_COUNT }, 1).count, MAX_COUNT);
  assert.equal(editCounter(c, { count: -5 }).counter.count, 0);
});

test("editing ignores bad fields and rejects bad commands", () => {
  const c = makeCounter({ label: "Dødsfald", command: "!death" });
  assert.equal(editCounter(c, { label: "   " }).counter.label, "Dødsfald");
  assert.equal(editCounter(c, { visible: false }).counter.visible, false);
  assert.ok(editCounter(c, { command: "!no way" }).error);
  assert.equal(editCounter(c, { command: "" }).counter.command, "");
});

test("a chat message matches a counter by its first word only", () => {
  const counters = defaultState().counters;
  assert.equal(counterForCommand(counters, "!death")?.label, "Dødsfald");
  assert.equal(counterForCommand(counters, "!DEATH lol")?.label, "Dødsfald");
  assert.equal(counterForCommand(counters, "he said !death"), null);
  assert.equal(counterForCommand(counters, "!deaths"), null);
  assert.ok(commandTaken(counters, "!strip"));
  assert.ok(!commandTaken(counters, "!strip", counters[1].id));
});

test("reorder and restore keep things sane", () => {
  const counters = defaultState().counters;
  assert.deepEqual(reorder(counters, [counters[2].id]).map((c) => c.label), ["Lucia sex", "Dødsfald", "Stripklub"]);
  assert.equal(restore(null).counters.length, 3);
  const r = restore({ channel: "bad name", counters: [{ id: "a", label: "X", count: 4 }, { id: "a", label: "dupe" }] });
  assert.deepEqual([r.channel, r.counters.length, r.counters[0].count], ["", 1, 4]);
});

test("the panel API counts, edits, adds, deletes; chat counts with a cooldown", async () => {
  let clock = 1_000_000;
  const followed = [];
  const chat = { follow: async (channel) => { followed.push(channel); return true; }, channel: () => followed.at(-1) || "" };
  const router = createGta6CountersApp({ chat, now: () => clock });
  const app = express();
  app.use("/gta6-counters", router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/gta6-counters/api`;
  const call = async (method, path, body) => {
    const r = await fetch(`${base}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    let s = (await call("GET", "state")).body;
    const [deaths, strip] = s.counters;

    s = (await call("POST", `counters/${deaths.id}/bump`, { by: 1 })).body;
    s = (await call("POST", `counters/${deaths.id}/bump`, { by: 1 })).body;
    s = (await call("POST", `counters/${deaths.id}/bump`, { by: -1 })).body;
    assert.equal(s.counters[0].count, 1);
    assert.deepEqual([s.lastChange.by, s.lastChange.via], [-1, "panel"]);

    assert.equal((await call("PATCH", `counters/${strip.id}`, { command: "!death" })).status, 400, "command already used");
    s = (await call("PATCH", `counters/${strip.id}`, { label: "Stripklub-besøg", count: 7 })).body;
    assert.deepEqual([s.counters[1].label, s.counters[1].count], ["Stripklub-besøg", 7]);

    s = (await call("PATCH", "settings", { channel: "twitch.tv/wendelbolol" })).body;
    assert.equal(s.channel, "wendelbolol");
    assert.equal(followed.at(-1), "wendelbolol");

    router.onChat("!death", "ModOne");
    router.onChat("!death", "ModTwo"); // same death, inside the cooldown
    s = (await call("GET", "state")).body;
    assert.equal(s.counters[0].count, 2);
    assert.deepEqual([s.lastChange.via, s.lastChange.username], ["chat", "ModOne"]);
    clock += CHAT_COOLDOWN_MS;
    router.onChat("!death", "ModTwo");
    router.onChat("!strip", "ModTwo"); // another counter has its own cooldown
    s = (await call("GET", "state")).body;
    assert.deepEqual([s.counters[0].count, s.counters[1].count], [3, 8]);

    assert.equal((await call("POST", "counters", { label: "", command: "!x" })).status, 400);
    s = (await call("POST", "counters", { label: "Politijagter", command: "politi" })).body;
    assert.deepEqual([s.counters.length, s.counters[3].command], [4, "!politi"]);
    s = (await call("DELETE", `counters/${s.counters[3].id}`)).body;
    assert.equal(s.counters.length, 3);

    s = (await call("POST", "reset-all")).body;
    assert.ok(s.counters.every((c) => c.count === 0));
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
