import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import tmi from "tmi.js";
import {
  createChannelRegistry,
  createChannelsRouter,
  createTenantDispatcher,
  hashKey,
  keyFromRequest
} from "../apps/_lib/channels.js";
import { createStoryTrackerApp } from "../apps/_lib/storyTracker.js";
import { createGauntletApp } from "../apps/gauntlet/app.js";
import { createRdr2DeathsApp } from "../apps/rdr2-deaths/app.js";
import brosvsbros from "../apps/brosvsbros/app.cjs";

// No DATABASE_URL here: every app keeps its state in memory, which is all these tests need.
// Opening a death counter normally joins the channel's real Twitch chat.
const chatClients = [];
tmi.Client.prototype.connect = async function () { return ["irc-ws.chat.twitch.tv", 443]; };
tmi.Client.prototype.join = async function (channel) { chatClients.push(this); return [channel]; };

const servers = [];
async function serve(mount) {
  const app = express();
  mount(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
test.after(() => { for (const server of servers) { server.closeAllConnections?.(); server.close(); } });

const json = (body) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const withKey = (key, extra = {}) => ({ "x-channel-key": key, "Content-Type": "application/json", ...extra });

test("keys are random, only stored as hashes, and each one opens exactly its own role", async () => {
  const registry = createChannelRegistry();
  const created = await registry.create();

  assert.match(created.id, /^[a-z2-7]{12}$/);
  assert.match(created.ownerKey, /^o_[a-z2-7]{26}$/);
  assert.match(created.trackerKey, /^t_[a-z2-7]{26}$/);
  assert.notEqual(created.ownerKey, (await registry.create()).ownerKey);

  const record = registry.get(created.id);
  assert.equal(record.ownerHash, hashKey(created.ownerKey));
  assert.ok(!JSON.stringify(record).includes(created.ownerKey), "the owner key itself must not be stored");
  assert.ok(!JSON.stringify(record).includes(created.trackerKey), "the tracker key itself must not be stored");

  const mod = await registry.addMod(created.id, "Sofie");
  assert.equal(registry.role(created.id, created.ownerKey), "owner");
  assert.equal(registry.role(created.id, created.trackerKey), "tracker");
  assert.equal(registry.role(created.id, mod.key), "mod");
  assert.equal(registry.role(created.id, "o_" + "a".repeat(26)), null);
  assert.equal(registry.role(created.id, ""), null);
  assert.equal(registry.role("aaaaaaaaaaaa", created.ownerKey), null, "a key only works in its own channel");
});

test("a key is taken back by rotating it or removing the mod", async () => {
  const registry = createChannelRegistry();
  const { id, ownerKey, trackerKey } = await registry.create();
  const mod = await registry.addMod(id, "Mod");

  const newOwner = await registry.rotate(id, "owner");
  assert.equal(registry.role(id, ownerKey), null);
  assert.equal(registry.role(id, newOwner), "owner");
  assert.equal(registry.role(id, trackerKey), "tracker", "rotating the owner key leaves the tracker alone");

  const newTracker = await registry.rotate(id, "tracker");
  assert.equal(registry.role(id, trackerKey), null);
  assert.equal(registry.role(id, newTracker), "tracker");

  assert.equal(await registry.removeMod(id, mod.mod.id), true);
  assert.equal(registry.role(id, mod.key), null);
});

test("the channel limit is enforced and only valid Twitch names are kept", async () => {
  const registry = createChannelRegistry({ limit: 2 });
  const first = await registry.create({ twitch: "#Some_Streamer" });
  await registry.create({ twitch: "not a name!" });
  assert.equal(registry.get(first.id).twitch, "some_streamer");
  assert.equal(registry.findByTwitch("some_streamer").length, 1);
  await assert.rejects(registry.create(), (error) => error.status === 503);
});

test("the key can come from the channel header, a bearer token or an old password header", () => {
  assert.equal(keyFromRequest({ headers: { "x-channel-key": " abc " } }), "abc");
  assert.equal(keyFromRequest({ headers: { authorization: "Bearer xyz" } }), "xyz");
  assert.equal(keyFromRequest({ headers: { "x-tlou2-key": "pw" } }), "pw");
  assert.equal(keyFromRequest({ headers: { "content-type": "application/json" } }), "");
});

test("the channel API: create, who-am-i, mods, rotate; mods cannot manage keys", async () => {
  const registry = createChannelRegistry();
  const base = await serve((app) => app.use("/api/channels", createChannelsRouter({ registry, adminKey: "host-secret" })));

  const created = await (await fetch(`${base}/api/channels`, { method: "POST", ...json({ twitch: "mychannel" }) })).json();
  assert.ok(created.id && created.ownerKey && created.trackerKey);

  const me = await fetch(`${base}/api/channels/${created.id}/me`, { headers: withKey(created.ownerKey) });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).role, "owner");
  assert.equal((await fetch(`${base}/api/channels/${created.id}/me`)).status, 401);
  assert.equal((await fetch(`${base}/api/channels/aaaaaaaaaaaa/me`)).status, 404);

  const publicView = await (await fetch(`${base}/api/channels/${created.id}`)).json();
  assert.deepEqual(Object.keys(publicView).sort(), ["createdAt", "id", "twitch"], "the public view never exposes keys or hashes");

  const modResponse = await fetch(`${base}/api/channels/${created.id}/mods`, { method: "POST", headers: withKey(created.ownerKey), body: JSON.stringify({ label: "Sofie" }) });
  assert.equal(modResponse.status, 201);
  const mod = await modResponse.json();
  const modMe = await (await fetch(`${base}/api/channels/${created.id}/me`, { headers: withKey(mod.key) })).json();
  assert.equal(modMe.role, "mod");
  assert.deepEqual(modMe.mods, [], "a mod does not see the other mods");

  const modTriesMods = await fetch(`${base}/api/channels/${created.id}/mods`, { method: "POST", headers: withKey(mod.key), body: "{}" });
  assert.equal(modTriesMods.status, 401);
  const modTriesRotate = await fetch(`${base}/api/channels/${created.id}/rotate`, { method: "POST", headers: withKey(mod.key), body: JSON.stringify({ which: "owner" }) });
  assert.equal(modTriesRotate.status, 401);

  assert.equal((await fetch(`${base}/api/channels/${created.id}/mods/${mod.mod.id}`, { method: "DELETE", headers: withKey(created.ownerKey) })).status, 200);
  assert.equal((await fetch(`${base}/api/channels/${created.id}/me`, { headers: withKey(mod.key) })).status, 401);

  const rotated = await (await fetch(`${base}/api/channels/${created.id}/rotate`, { method: "POST", headers: withKey(created.ownerKey), body: JSON.stringify({ which: "owner" }) })).json();
  assert.equal((await fetch(`${base}/api/channels/${created.id}/me`, { headers: withKey(created.ownerKey) })).status, 401);
  assert.equal((await fetch(`${base}/api/channels/${created.id}/me`, { headers: withKey(rotated.key) })).status, 200);
});

test("only the host can reset the keys of a channel or delete it", async () => {
  const registry = createChannelRegistry();
  const base = await serve((app) => app.use("/api/channels", createChannelsRouter({ registry, adminKey: "host-secret" })));
  const created = await (await fetch(`${base}/api/channels`, { method: "POST", ...json({}) })).json();

  assert.equal((await fetch(`${base}/api/channels/${created.id}/admin-reset`, { method: "POST", headers: withKey(created.ownerKey) })).status, 403);
  const reset = await fetch(`${base}/api/channels/${created.id}/admin-reset`, { method: "POST", headers: { "x-admin-key": "host-secret" } });
  assert.equal(reset.status, 200);
  const keys = await reset.json();
  assert.equal(registry.role(created.id, keys.ownerKey), "owner");
  assert.equal(registry.role(created.id, created.ownerKey), null);

  assert.equal((await fetch(`${base}/api/channels/${created.id}`, { method: "DELETE" })).status, 403);
  assert.equal((await fetch(`${base}/api/channels/${created.id}`, { method: "DELETE", headers: { "x-admin-key": "host-secret" } })).status, 200);
  assert.equal(registry.has(created.id), false);
});

test("without HUB_ADMIN_KEY nobody can use the admin routes", async () => {
  const registry = createChannelRegistry();
  const base = await serve((app) => app.use("/api/channels", createChannelsRouter({ registry, adminKey: "" })));
  const created = await (await fetch(`${base}/api/channels`, { method: "POST", ...json({}) })).json();
  const response = await fetch(`${base}/api/channels/${created.id}/admin-reset`, { method: "POST", headers: { "x-admin-key": "" } });
  assert.equal(response.status, 403);
});

test("creating channels is limited per visitor", async () => {
  const registry = createChannelRegistry();
  const base = await serve((app) => app.use("/api/channels", createChannelsRouter({ registry })));
  for (let i = 0; i < 6; i++) assert.equal((await fetch(`${base}/api/channels`, { method: "POST", ...json({}) })).status, 201);
  assert.equal((await fetch(`${base}/api/channels`, { method: "POST", ...json({}) })).status, 429);
  assert.equal(registry.count(), 6);
});

test("guessing keys locks the guesser out, even for the right key", async () => {
  const registry = createChannelRegistry();
  const base = await serve((app) => app.use("/api/channels", createChannelsRouter({ registry })));
  const { id, ownerKey } = await (await fetch(`${base}/api/channels`, { method: "POST", ...json({}) })).json();

  for (let i = 0; i < 40; i++) {
    const guess = await fetch(`${base}/api/channels/${id}/mods`, { method: "POST", headers: withKey(`o_guess${i}`), body: "{}" });
    assert.equal(guess.status, 401);
  }
  const rightKeyNow = await fetch(`${base}/api/channels/${id}/mods`, { method: "POST", headers: withKey(ownerKey), body: "{}" });
  assert.equal(rightKeyNow.status, 429);
});

test("guessing at one channel does not lock anyone out of another, and the admin key is guarded too", async () => {
  const registry = createChannelRegistry();
  const base = await serve((app) => app.use("/api/channels", createChannelsRouter({ registry, adminKey: "host-secret" })));
  const target = await (await fetch(`${base}/api/channels`, { method: "POST", ...json({}) })).json();
  const other = await (await fetch(`${base}/api/channels`, { method: "POST", ...json({}) })).json();

  for (let i = 0; i < 40; i++) await fetch(`${base}/api/channels/${target.id}/mods`, { method: "POST", headers: withKey(`o_guess${i}`), body: "{}" });
  assert.equal((await fetch(`${base}/api/channels/${target.id}/mods`, { method: "POST", headers: withKey(target.ownerKey), body: "{}" })).status, 429);
  assert.equal((await fetch(`${base}/api/channels/${other.id}/mods`, { method: "POST", headers: withKey(other.ownerKey), body: "{}" })).status, 201, "the other channel is not affected");

  for (let i = 0; i < 40; i++) await fetch(`${base}/api/channels/${other.id}/admin-reset`, { method: "POST", headers: { "x-admin-key": `guess${i}` } });
  const rightAdminKey = await fetch(`${base}/api/channels/${other.id}/admin-reset`, { method: "POST", headers: { "x-admin-key": "host-secret" } });
  assert.equal(rightAdminKey.status, 403, "even the right admin key is refused after too many guesses");
});

// ---- the story trackers (TLOU2, Mafia, Cyberpunk) -------------------------------------------------

const chapter = (input) => ({ id: input.id || String(input.day), day: String(input.day || ""), location: "", part: null });

async function storyApp() {
  process.env.STORYCH_CONTROL_PASSWORD = "legacy-password";
  process.env.STORYCH_TRACKER_KEY = "legacy-tracker";
  const registry = createChannelRegistry();
  const router = createStoryTrackerApp({
    publicDir: ".",
    envPrefix: "STORYCH",
    dbTable: "storych_state",
    defaultChapters: [{ day: "one" }, { day: "two" }, { day: "three" }],
    cleanChapter: chapter,
    matchText: (c) => c.day,
    channels: registry
  });
  const base = await serve((app) => app.use("/t", router));
  return { registry, base: `${base}/t` };
}

const jump = (base, profile, headers, index = 1) => fetch(`${base}/api/current?profile=${profile}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ index }) });

test("a story tracker channel is changed with the channel's own keys and nothing else", async () => {
  const { registry, base } = await storyApp();
  const { id, ownerKey, trackerKey } = await registry.create();
  const mod = await registry.addMod(id, "Mod");

  assert.equal((await jump(base, id, {})).status, 401, "no key");
  assert.equal((await jump(base, id, { "x-storych-key": "legacy-password" })).status, 401, "the shared password does not open a channel");
  assert.equal((await jump(base, id, { "x-channel-key": trackerKey })).status, 401, "the tracker key may not use the panel");
  assert.equal((await jump(base, id, { "x-channel-key": "o_wrong" })).status, 401, "wrong key");
  assert.equal((await jump(base, id, { "x-channel-key": ownerKey }, 1)).status, 200);
  assert.equal((await jump(base, id, { "x-channel-key": mod.key }, 2)).status, 200);

  const state = await (await fetch(`${base}/api/state?profile=${id}`)).json();
  assert.equal(state.currentIndex, 2);
  assert.equal(state.passwordRequired, true);
  assert.equal(state.trackerConfigured, true);
});

test("a tracker script feeds a channel with the channel's tracker key (or the owner key), never a mod key or the shared key", async () => {
  const { registry, base } = await storyApp();
  const { id, ownerKey, trackerKey } = await registry.create();
  const mod = await registry.addMod(id, "Mod");
  const send = (token) => fetch(`${base}/api/tracker?profile=${id}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "two" }) });

  assert.equal((await send("legacy-tracker")).status, 401);
  assert.equal((await send(mod.key)).status, 401);
  assert.equal((await send(trackerKey)).status, 200);
  assert.equal((await send(ownerKey)).status, 200);
  assert.equal((await (await fetch(`${base}/api/state?profile=${id}`)).json()).currentIndex, 1);
});

test("channels do not see each other's progress, and the old shared-password profiles keep working", async () => {
  const { registry, base } = await storyApp();
  const a = await registry.create();
  const b = await registry.create();
  await jump(base, a.id, { "x-channel-key": a.ownerKey }, 2);

  assert.equal((await (await fetch(`${base}/api/state?profile=${b.id}`)).json()).currentIndex, -1);
  assert.equal((await jump(base, b.id, { "x-channel-key": a.ownerKey })).status, 401, "a's key does nothing in b");

  // A profile that is not a channel (what friends used before) still takes the shared password.
  assert.equal((await jump(base, "oldfriend", {})).status, 401);
  assert.equal((await jump(base, "oldfriend", { "x-storych-key": "legacy-password" })).status, 200);
  assert.equal((await jump(base, "oldfriend", { "x-channel-key": a.ownerKey })).status, 401);
  assert.equal((await (await fetch(`${base}/api/state?profile=oldfriend`)).json()).passwordRequired, true);
});

// ---- apps that get a copy per channel (Gauntlet) --------------------------------------------------

async function gauntletApp() {
  delete process.env.GAUNTLET_CONTROL_PASSWORD;
  const registry = createChannelRegistry();
  const dispatcher = createTenantDispatcher({
    registry,
    legacy: createGauntletApp(),
    factory: (context) => createGauntletApp(context)
  });
  const base = await serve((app) => app.use("/g", dispatcher));
  return { registry, dispatcher, base: `${base}/g` };
}

const addGame = (base, profile, key, name = "Elden Ring") =>
  fetch(`${base}/api/games${profile ? `?profile=${profile}` : ""}`, { method: "POST", headers: withKey(key || ""), body: JSON.stringify({ name }) });

test("a channel gets its own copy of the app: its changes need a key and never reach anyone else", async () => {
  const { registry, dispatcher, base } = await gauntletApp();
  const a = await registry.create();
  const b = await registry.create();
  const legacyBefore = (await (await fetch(`${base}/api/state`)).json()).games.length;

  assert.equal((await addGame(base, a.id, "")).status, 401);
  assert.equal((await addGame(base, a.id, b.ownerKey)).status, 401, "another channel's key");
  assert.equal((await addGame(base, a.id, a.ownerKey)).status, 200);

  const stateA = await (await fetch(`${base}/api/state?profile=${a.id}`)).json();
  const stateB = await (await fetch(`${base}/api/state?profile=${b.id}`)).json();
  const legacy = await (await fetch(`${base}/api/state`)).json();
  assert.equal(stateA.games.length, legacyBefore + 1);
  assert.equal(stateB.games.length, legacyBefore);
  assert.equal(legacy.games.length, legacyBefore, "the main overlay is untouched");
  assert.equal(stateA.passwordRequired, true);
  assert.equal(dispatcher.instanceCount(), 2);
});

test("a mod may change a channel but the tracker key may not", async () => {
  const { registry, base } = await gauntletApp();
  const channel = await registry.create();
  const mod = await registry.addMod(channel.id, "Mod");
  assert.equal((await addGame(base, channel.id, mod.key, "Hades")).status, 200);
  assert.equal((await addGame(base, channel.id, channel.trackerKey, "Hades")).status, 401);
});

test("an unknown channel is a 404, never somebody else's overlay", async () => {
  const { base } = await gauntletApp();
  const asJson = await fetch(`${base}/api/state?profile=aaaaaaaaaaaa`);
  assert.equal(asJson.status, 404);
  const asPage = await fetch(`${base}/?profile=aaaaaaaaaaaa`, { headers: { Accept: "text/html" } });
  assert.equal(asPage.status, 404);
  assert.match(await asPage.text(), /Ukendt kanal/);
});

test("the main overlay still uses its own password when it has one", async () => {
  process.env.GAUNTLET_CONTROL_PASSWORD = "main-password";
  try {
    const registry = createChannelRegistry();
    const base = await serve((app) => app.use("/g", createTenantDispatcher({ registry, legacy: createGauntletApp(), factory: (context) => createGauntletApp(context) })));
    const response = await fetch(`${base}/g/api/games`, { method: "POST", headers: { "Content-Type": "application/json", "x-gauntlet-key": "main-password" }, body: JSON.stringify({ name: "Doom" }) });
    assert.equal(response.status, 200);
    const denied = await fetch(`${base}/g/api/games`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Doom" }) });
    assert.equal(denied.status, 401);
  } finally {
    delete process.env.GAUNTLET_CONTROL_PASSWORD;
  }
});

// ---- the death counter ----------------------------------------------------------------------------

test("a channel's death counter is its own, and !died in its Twitch chat counts up", async () => {
  delete process.env.RDR2DEATHS_CONTROL_PASSWORD;
  const registry = createChannelRegistry();
  const channel = await registry.create({ twitch: "streamerx" });
  const other = await registry.create({ twitch: "streamerx" });
  const base = await serve((app) => app.use("/d", createRdr2DeathsApp({ channels: registry })));
  const url = `${base}/d`;

  const bump = (profile, key) => fetch(`${url}/api/increment?profile=${profile}`, { method: "POST", headers: key ? withKey(key) : {} });
  assert.equal((await bump(channel.id)).status, 401);
  assert.equal((await bump(channel.id, other.ownerKey)).status, 401);
  assert.equal((await bump(channel.id, channel.ownerKey)).status, 200);

  // Opening the counter joins the channel's chat; a broadcaster typing !died counts for the channels using that chat.
  const state = await (await fetch(`${url}/api/state?profile=${channel.id}`)).json();
  assert.equal(state.count, 1);
  assert.equal(state.channel, "streamerx");
  await fetch(`${url}/api/state?profile=${other.id}`);
  const client = chatClients.at(-1);
  client.emit("message", "#streamerx", { badges: { broadcaster: "1" }, "display-name": "StreamerX" }, "!died", false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await (await fetch(`${url}/api/state?profile=${channel.id}`)).json()).count, 2);
  assert.equal((await (await fetch(`${url}/api/state?profile=${other.id}`)).json()).count, 1, "its own count, plus the chat one");

  // A viewer's !died does nothing, and the old Twitch-name counter for the same chat was never opened.
  client.emit("message", "#streamerx", { badges: {}, "display-name": "viewer" }, "!died", false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await (await fetch(`${url}/api/state?profile=${channel.id}`)).json()).count, 2);
  assert.equal((await (await fetch(`${url}/api/state?channel=streamerx`)).json()).count, 0);

  assert.equal((await fetch(`${url}/api/state?profile=aaaaaaaaaaaa`)).status, 404);
});

// ---- Bros vs Bros (socket.io: one room per channel) ------------------------------------------------

// A stand-in for a browser's socket: remembers what the server sent and lets the test fire panel actions.
function fakeSocket() {
  const socket = { handshake: { address: "9.9.9.9", headers: {} }, sent: [], handlers: {} };
  socket.emit = (event, data) => socket.sent.push([event, data]);
  socket.on = (event, handler) => { socket.handlers[event] = handler; };
  socket.act = (payload) => socket.handlers["panel:action"](payload);
  socket.last = (event) => socket.sent.filter(([name]) => name === event).at(-1)?.[1];
  return socket;
}

test("each channel's Bros vs Bros room has its own scores, and its panel needs the channel's key", async () => {
  const registry = createChannelRegistry();
  const a = await registry.create();
  const b = await registry.create();
  const mod = await registry.addMod(a.id, "Mod");
  const room = (channel) => {
    const broadcasts = [];
    const app = brosvsbros.createBrosvsbrosApp({
      channelId: channel.id,
      emit: (event, data) => broadcasts.push([event, structuredClone(data)]),
      authorizeToken: (token) => registry.authorize(channel.id, { ip: "9.9.9.9" }, ["owner", "mod"], token)
    });
    return { app, broadcasts };
  };
  const roomA = room(a);
  const roomB = room(b);
  await roomA.app.ready;

  const panelA = fakeSocket();
  roomA.app.onConnection(panelA);
  assert.equal(panelA.last("config").requiresKey, true, "a channel's panel is always locked");

  assert.doesNotThrow(() => {
    panelA.act(null);
    panelA.act(undefined);
    panelA.act("not an action");
    panelA.act({ type: "score:inc", player: "left", token: { not: "a string" } });
  }, "whatever a browser sends must not crash the server");
  panelA.sent.length = 0;

  panelA.act({ type: "score:inc", player: "left" });
  assert.ok(panelA.sent.some(([event]) => event === "panel:denied"), "no key");
  panelA.act({ type: "score:inc", player: "left", token: b.ownerKey });
  assert.equal(panelA.sent.filter(([event]) => event === "panel:denied").length, 2, "another channel's key");
  panelA.act({ type: "score:inc", player: "left", token: a.trackerKey });
  assert.equal(panelA.sent.filter(([event]) => event === "panel:denied").length, 3, "the tracker key may not use the panel");
  assert.equal(roomA.broadcasts.length, 0, "nothing changed so far");

  panelA.act({ type: "score:inc", player: "left", token: a.ownerKey });
  panelA.act({ type: "score:inc", player: "left", token: mod.key });
  assert.equal(roomA.broadcasts.at(-1)[1].scores.left, 2);

  const viewerB = fakeSocket();
  roomB.app.onConnection(viewerB);
  assert.equal(viewerB.last("state").scores.left, 0, "the other channel is untouched");
});

test("a Bros vs Bros link to an unknown channel is a 404 and the redirects keep the channel", async () => {
  const registry = createChannelRegistry();
  const channel = await registry.create();
  const { router } = brosvsbros.createBrosvsbrosApp({ channels: registry });
  const base = await serve((app) => app.use("/brosvsbros", router));

  assert.equal((await fetch(`${base}/brosvsbros/overlay?profile=aaaaaaaaaaaa`)).status, 404);
  assert.equal((await fetch(`${base}/brosvsbros/overlay?profile=${channel.id}`)).status, 200);
  const redirect = await fetch(`${base}/brosvsbros/?profile=${channel.id}`, { redirect: "manual" });
  assert.match(redirect.headers.get("location"), new RegExp(`/brosvsbros/overlay\\?profile=${channel.id}$`));
  const duel = await fetch(`${base}/brosvsbros/duel?profile=${channel.id}`, { redirect: "manual" });
  assert.match(duel.headers.get("location"), new RegExp(`view=duel`));
  assert.match(duel.headers.get("location"), new RegExp(`profile=${channel.id}`));
});

// ---- the whole hub --------------------------------------------------------------------------------

async function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

test("the hub puts the channel shim on a channel's pages, and only on those", async (t) => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_URL: "", WALK_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("listening")) resolve(); });
    child.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
    setTimeout(() => reject(new Error("server did not start")), 15000);
  });
  const base = `http://127.0.0.1:${port}`;

  const created = await (await fetch(`${base}/api/channels`, { method: "POST", ...json({}) })).json();
  assert.ok(created.id);

  const panel = await (await fetch(`${base}/tlou2/control.html?profile=${created.id}`)).text();
  assert.match(panel, /<script src="\/_hub\/channel\.js"><\/script>/);
  const overlay = await (await fetch(`${base}/tlou2/?profile=${created.id}`)).text();
  assert.match(overlay, /\/_hub\/channel\.js/);
  assert.match(overlay, /Kopiér link til OBS/, "the copy-link button is still added to overlays");
  assert.doesNotMatch(panel, /Kopiér link til OBS/, "but not to control panels");
  const plain = await (await fetch(`${base}/tlou2/control.html`)).text();
  assert.doesNotMatch(plain, /_hub\/channel\.js/, "pages without a channel are untouched");

  const shim = await fetch(`${base}/_hub/channel.js`);
  assert.equal(shim.status, 200);
  assert.equal((await fetch(`${base}/kanal/`)).status, 200);

  const unknown = await fetch(`${base}/minecraft/overlay?profile=aaaaaaaaaaaa`, { headers: { Accept: "text/html" } });
  assert.equal(unknown.status, 404);
  const minecraft = await (await fetch(`${base}/minecraft/overlay?profile=${created.id}`)).text();
  assert.match(minecraft, /\/_hub\/channel\.js/);
});
