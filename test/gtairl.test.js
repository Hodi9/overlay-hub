import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { MAX_GOALS, SCALE_MAX, addGoals, cleanGoal, cleanPlan, completeCurrent, progress, removeGoal, reorder, resetAll, restore, undoLast, updateGoal } from "../apps/gtairl/state.js";
import { createGtaIrlApp } from "../apps/gtairl/app.js";
import { createChannelRegistry, createTenantDispatcher } from "../apps/_lib/channels.js";

const texts = (goals) => goals.map((goal) => goal.text);
const make = (...rows) => rows.map(([text, done = false, kind = "place"]) => cleanGoal({ text, done, kind }));

test("cleanGoal ignores invalid fields and keeps the old text when the new one is empty", () => {
  const goal = cleanGoal({ text: "  Nyhavn  ", kind: "beach", done: "ja" });
  assert.deepEqual([goal.text, goal.kind, goal.done], ["Nyhavn", "place", false]);
  assert.equal(cleanGoal({ text: "   " }, goal).text, "Nyhavn");
  assert.equal(cleanGoal({ kind: "activity" }, goal).kind, "activity");
  assert.equal(cleanGoal({ text: "x".repeat(200) }).text.length, 60);
});

test("a pasted list becomes one goal per line, without bullets or numbers, and stops at the limit", () => {
  const added = addGoals([], { text: "1. Nyhavn\n\n- Buy a hot dog\r\n• Tivoli\n  ", kind: "activity" });
  assert.deepEqual(texts(added.goals), ["Nyhavn", "Buy a hot dog", "Tivoli"]);
  assert.ok(added.goals.every((goal) => goal.kind === "activity" && !goal.done));
  assert.equal(addGoals([], { text: "  \n " }), null);
  assert.equal(addGoals([], {}), null);
  const almost = make(...Array.from({ length: MAX_GOALS - 1 }, (_, i) => [`G${i}`]));
  assert.equal(addGoals(almost, { text: "a\nb\nc" }).goals.length, MAX_GOALS);
  assert.equal(addGoals([...almost, ...make(["last"])], { text: "a" }), null);
});

test("the current goal is the first one not done, the next is the one after it", () => {
  const goals = make(["A", true], ["B"], ["C", true], ["D"], ["E"]);
  const p = progress(goals);
  assert.deepEqual([p.done, p.total, p.percent, p.current.text, p.next.text, p.finished], [2, 5, 40, "B", "D", false]);
  assert.deepEqual(progress([]), { done: 0, total: 0, percent: 0, current: null, next: null, finished: false });
  const all = progress(make(["A", true]));
  assert.deepEqual([all.current, all.next, all.finished], [null, null, true]);
  assert.equal(progress(make(["A", true], ["B"], ["C"])).percent, 33.3);
});

test("Klaret ticks off the current goal and Fortryd takes the last tick off again", () => {
  const goals = make(["A"], ["B"], ["C"]);
  const once = completeCurrent(goals);
  const twice = completeCurrent(once);
  assert.equal(progress(twice).current.text, "C");
  assert.deepEqual(twice.map((g) => g.done), [true, true, false]);
  assert.deepEqual(undoLast(twice).map((g) => g.done), [true, false, false]);
  const done = make(["A", true]);
  assert.equal(completeCurrent(done), done);
  assert.deepEqual(undoLast(make(["A"])).map((g) => g.done), [false]);
  assert.ok(resetAll(twice).every((g) => !g.done));
});

test("updating, removing and reordering goals", () => {
  const goals = make(["A"], ["B"], ["C"]);
  const moved = updateGoal(goals, goals[1].id, { done: true, kind: "activity" });
  assert.deepEqual([moved[1].done, moved[1].kind, moved[0].done], [true, "activity", false]);
  assert.equal(updateGoal(goals, "findes-ikke", { done: true }), null);
  assert.deepEqual(texts(removeGoal(goals, goals[0].id)), ["B", "C"]);
  assert.deepEqual(texts(reorder(goals, [goals[2].id, goals[0].id])), ["C", "A", "B"]);
  assert.deepEqual(texts(reorder(goals, "nonsense")), ["A", "B", "C"]);
});

test("the plan: title, whole list or not, and size", () => {
  assert.deepEqual(cleanPlan({}), { title: "GTA IRL", showAll: false, scale: 1 });
  const before = { title: "Copenhagen", showAll: true, scale: 1.3 };
  assert.deepEqual(cleanPlan({ showAll: "ja", scale: "stor" }, before), before);
  assert.equal(cleanPlan({ showAll: false }, before).showAll, false);
  assert.equal(cleanPlan({ scale: 9 }).scale, SCALE_MAX);
  assert.equal(cleanPlan({ title: "x".repeat(100) }).title.length, 30);
});

test("restore reads saved state and shrugs off garbage", () => {
  assert.deepEqual(restore(null), { plan: { title: "GTA IRL", showAll: false, scale: 1 }, goals: [] });
  const saved = restore({ plan: { showAll: true }, goals: [{ id: "1", text: "Nyhavn", done: true }, { id: "2", text: "" }, null, { id: "3", text: "Tivoli", kind: "activity" }] });
  assert.equal(saved.plan.showAll, true);
  assert.deepEqual(saved.goals.map((g) => [g.id, g.text, g.done, g.kind]), [["1", "Nyhavn", true, "place"], ["3", "Tivoli", false, "activity"]]);
});

async function serve(mount, fn) {
  const app = express();
  mount(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}/gta-irl`); } finally { server.close(); }
}
async function withApp(password, fn) {
  const old = process.env.GTAIRL_CONTROL_PASSWORD;
  if (password) process.env.GTAIRL_CONTROL_PASSWORD = password; else delete process.env.GTAIRL_CONTROL_PASSWORD;
  try { await serve((app) => app.use("/gta-irl", createGtaIrlApp()), fn); } finally {
    if (old === undefined) delete process.env.GTAIRL_CONTROL_PASSWORD; else process.env.GTAIRL_CONTROL_PASSWORD = old;
  }
}
const send = (url, method, body, headers = {}) => fetch(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (response) => (await response).json();

test("the panel API needs the password, the overlay does not", async () => {
  await withApp("hemmelig", async (base) => {
    assert.equal((await send(`${base}/api/goals`, "POST", { text: "Nyhavn" })).status, 401);
    assert.equal((await send(`${base}/api/complete`, "POST", undefined, { "x-gtairl-key": "forkert" })).status, 401);
    assert.equal((await send(`${base}/api/login`, "POST", {}, { "x-gtairl-key": "hemmelig" })).status, 200);
    assert.equal((await send(`${base}/api/goals`, "POST", { text: "Nyhavn" }, { "x-gtairl-key": "hemmelig" })).status, 200);
    const state = await json(fetch(`${base}/api/state`));
    assert.deepEqual([texts(state.goals), state.progress.current.text, state.passwordRequired], [["Nyhavn"], "Nyhavn", true]);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/control.html`)).status, 200);
  });
});

test("a whole stream through the API", async () => {
  await withApp("", async (base) => {
    assert.equal((await send(`${base}/api/goals`, "POST", { text: " " })).status, 400);
    const added = await json(send(`${base}/api/goals`, "POST", { text: "Nyhavn\nTivoli" }));
    await send(`${base}/api/goals`, "POST", { text: "Buy a hot dog", kind: "activity" });
    let state = await json(send(`${base}/api/complete`, "POST"));
    assert.deepEqual([state.progress.done, state.progress.current.text, state.progress.next.text], [1, "Tivoli", "Buy a hot dog"]);
    const [nyhavn, tivoli] = added.goals.map((g) => g.id);
    state = await json(send(`${base}/api/order`, "PUT", { ids: [nyhavn, state.goals[2].id, tivoli] }));
    assert.equal(state.progress.current.text, "Buy a hot dog");
    state = await json(send(`${base}/api/goals/${tivoli}`, "PATCH", { kind: "activity", text: "Ride the roller coaster" }));
    assert.deepEqual([state.goals[2].kind, state.goals[2].text], ["activity", "Ride the roller coaster"]);
    assert.equal((await send(`${base}/api/goals/findes-ikke`, "PATCH", { done: true })).status, 404);
    state = await json(send(`${base}/api/undo`, "POST"));
    assert.equal(state.progress.done, 0);
    state = await json(send(`${base}/api/plan`, "PATCH", { showAll: true, title: "Anker IRL" }));
    assert.deepEqual([state.plan.showAll, state.plan.title], [true, "Anker IRL"]);
    await send(`${base}/api/complete`, "POST");
    state = await json(send(`${base}/api/reset`, "POST"));
    assert.equal(state.progress.done, 0);
    state = await json(send(`${base}/api/goals/${nyhavn}`, "DELETE"));
    assert.equal(state.goals.length, 2);
    state = await json(send(`${base}/api/clear`, "POST"));
    assert.deepEqual([state.goals, state.progress.current], [[], null]);
  });
});

test("every open overlay hears about a change straight away", async () => {
  await withApp("", async (base) => {
    const controller = new AbortController();
    const reader = (await fetch(`${base}/api/events`, { signal: controller.signal })).body.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);
    assert.match(await next(), /GTA IRL/);
    await send(`${base}/api/goals`, "POST", { text: "Rundetaarn" });
    assert.match(await next(), /Rundetaarn/);
    controller.abort();
  });
});

test("each channel keeps its own list and needs its own key", async () => {
  const registry = createChannelRegistry();
  const anker = await registry.create({ twitch: "ankerrrrrrrrrr" });
  const other = await registry.create();
  await serve((app) => app.use("/gta-irl", createTenantDispatcher({ registry, legacy: createGtaIrlApp(), factory: (context) => createGtaIrlApp(context) })), async (base) => {
    const key = (k) => ({ "x-channel-key": k });
    assert.equal((await send(`${base}/api/goals?profile=${anker.id}`, "POST", { text: "Nyhavn" })).status, 401);
    assert.equal((await send(`${base}/api/goals?profile=${anker.id}`, "POST", { text: "Nyhavn" }, key(other.ownerKey))).status, 401);
    assert.equal((await send(`${base}/api/goals?profile=${anker.id}`, "POST", { text: "Nyhavn" }, key(anker.ownerKey))).status, 200);
    const mine = await json(fetch(`${base}/api/state?profile=${anker.id}`));
    const theirs = await json(fetch(`${base}/api/state?profile=${other.id}`));
    assert.deepEqual([texts(mine.goals), texts(theirs.goals), mine.passwordRequired], [["Nyhavn"], [], false]);
    assert.equal((await fetch(`${base}/api/state?profile=aaaaaaaaaaaa`)).status, 404);
  });
});
