import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ACCENTS, MAX_GUESTS, SCALE_MAX, SCALE_MIN, addGuest, cleanGuest, cleanPlan, everyoneOut, removeGuest, reorder, restore, updateGuest } from "../apps/gaester/state.js";
import { createGaesterApp } from "../apps/gaester/app.js";

const names = (guests) => guests.map((guest) => guest.name);
const make = (...rows) => rows.map(([name, role = "", here = false]) => cleanGuest({ name, role, here }));

test("cleanGuest ignores invalid fields and keeps the old name when the new one is empty", () => {
  const guest = cleanGuest({ name: "  Alice Example  ", role: "x".repeat(200), here: "ja" });
  assert.deepEqual([guest.name, guest.role.length, guest.here], ["Alice Example", 50, false]);
  assert.equal(cleanGuest({ name: "   " }, guest).name, "Alice Example");
  assert.equal(cleanGuest({ here: true }, guest).here, true);
  assert.equal(cleanGuest({ role: "Producer" }, guest).role, "Producer");
});

test("adding a guest needs a name and stops at the limit; new guests are not in the studio yet", () => {
  const added = addGuest([], { name: "Alice Example", role: "Producer" });
  assert.deepEqual([added.guest.name, added.guest.role, added.guest.here], ["Alice Example", "Producer", false]);
  assert.equal(addGuest([], { name: "   " }), null);
  assert.equal(addGuest(Array.from({ length: MAX_GUESTS }, () => cleanGuest({ name: "x" })), { name: "y" }), null);
  assert.equal(addGuest([], { name: "Bob Example", here: true }).guest.here, true);
});

test("updating, removing and reordering guests", () => {
  const guests = make(["Alice", "Producer"], ["Bob", "Musiker"], ["Carol"]);
  const moved = updateGuest(guests, guests[1].id, { here: true, role: "Vokalist" });
  assert.deepEqual([moved[1].here, moved[1].role, moved[0].here], [true, "Vokalist", false]);
  assert.equal(updateGuest(guests, "findes-ikke", { here: true }), null);
  assert.deepEqual(names(removeGuest(guests, guests[0].id)), ["Bob", "Carol"]);
  assert.deepEqual(names(reorder(guests, [guests[2].id, guests[0].id])), ["Carol", "Alice", "Bob"]);
  assert.deepEqual(names(reorder(guests, [guests[1].id, guests[1].id, "x"])), ["Bob", "Alice", "Carol"]);
  assert.deepEqual(names(reorder(guests, "nonsense")), ["Alice", "Bob", "Carol"]);
});

test("everyoneOut sends all guests out of the studio but keeps them on the list", () => {
  const guests = make(["Alice", "", true], ["Bob", "", true], ["Carol"]);
  const out = everyoneOut(guests);
  assert.deepEqual(names(out), ["Alice", "Bob", "Carol"]);
  assert.ok(out.every((guest) => !guest.here));
});

test("the colour is one of the known ones and defaults to lime", () => {
  assert.equal(cleanPlan({}).accent, "lime");
  for (const accent of ACCENTS) assert.equal(cleanPlan({ accent }).accent, accent);
  assert.equal(cleanPlan({ accent: "grøn" }, { kicker: "A", accent: "violet" }).accent, "violet");
  assert.deepEqual(cleanPlan({ kicker: "" }, { kicker: "A", accent: "pink", scale: 1 }), { kicker: "", accent: "pink", scale: 1 });
  assert.equal(cleanPlan({ kicker: "x".repeat(100) }).kicker.length, 30);
});

test("the size is a number between 60 % and 200 % and defaults to 100 %", () => {
  const before = { kicker: "A", accent: "pink", scale: 1.3 };
  assert.equal(cleanPlan({}).scale, 1);
  assert.equal(cleanPlan({ scale: 1.1 }).scale, 1.1);
  assert.equal(cleanPlan({ scale: 0.1 }).scale, SCALE_MIN); // too small: the smallest
  assert.equal(cleanPlan({ scale: 9 }).scale, SCALE_MAX); // too big: the biggest
  assert.equal(cleanPlan({ scale: 1.2345 }).scale, 1.23); // two decimals are enough
  for (const bad of ["1.2", "stor", null, NaN, Infinity, {}]) assert.equal(cleanPlan({ scale: bad }, before).scale, 1.3, String(bad)); // not a number: the old size stays
  assert.equal(cleanPlan({ accent: "blue" }, before).scale, 1.3); // changing the colour does not reset it
  assert.equal(restore({ plan: { scale: 1.5 }, guests: [] }).plan.scale, 1.5);
  assert.equal(restore({ plan: { accent: "blue" }, guests: [] }).plan.scale, 1); // saved before the size existed
});

test("restore reads saved state and shrugs off garbage", () => {
  assert.deepEqual(restore(null).guests, []);
  assert.equal(restore(null).plan.accent, "lime");
  const saved = restore({ plan: { accent: "blue" }, guests: [{ id: "1", name: "Alice", here: true }, { id: "2", name: "" }, null, { id: "3", name: "Bob", role: "Musiker" }] });
  assert.equal(saved.plan.accent, "blue");
  assert.deepEqual([names(saved.guests).join(), saved.guests.map((g) => g.id).join(), saved.guests.map((g) => g.here).join()], ["Alice,Bob", "1,3", "true,false"]);
});

async function withGaester(password, fn) {
  const old = process.env.GAESTER_CONTROL_PASSWORD;
  if (password) process.env.GAESTER_CONTROL_PASSWORD = password; else delete process.env.GAESTER_CONTROL_PASSWORD;
  const app = express();
  app.use("/gaester", createGaesterApp());
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}/gaester`); } finally {
    server.close();
    if (old === undefined) delete process.env.GAESTER_CONTROL_PASSWORD; else process.env.GAESTER_CONTROL_PASSWORD = old;
  }
}
const send = (url, method, body, key) => fetch(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(key ? { "x-gaester-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (base) => (await fetch(`${base}/api/state`)).json();

test("the panel API needs the password, the overlay does not", async () => {
  await withGaester("hemmelig", async (base) => {
    assert.equal((await send(`${base}/api/guests`, "POST", { name: "Alice Example" })).status, 401);
    assert.equal((await send(`${base}/api/guests`, "POST", { name: "Alice Example" }, "forkert")).status, 401);
    assert.equal((await send(`${base}/api/login`, "POST", {}, "hemmelig")).status, 200);
    assert.equal((await send(`${base}/api/guests`, "POST", { name: "Alice Example", role: "Producer" }, "hemmelig")).status, 200);
    const state = await read(base);
    assert.deepEqual([state.guests[0].name, state.guests[0].role, state.passwordRequired], ["Alice Example", "Producer", true]);
    assert.match((await fetch(`${base}/api/state`)).headers.get("x-robots-tag"), /noindex/);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/control.html`)).status, 200);
  });
});

test("guests come and go through the API", async () => {
  await withGaester("", async (base) => {
    const first = await read(base);
    assert.deepEqual([first.guests, first.plan.kicker, first.plan.accent, first.passwordRequired], [[], "I studiet nu", "lime", false]);
    assert.equal((await send(`${base}/api/guests`, "POST", { name: "   " })).status, 400);
    const a = await (await send(`${base}/api/guests`, "POST", { name: "Alice Example", role: "Producer", here: true })).json();
    const b = await (await send(`${base}/api/guests`, "POST", { name: "Bob Example", role: "Musiker" })).json();
    assert.deepEqual(b.guests.map((g) => [g.name, g.here]), [["Alice Example", true], ["Bob Example", false]]);
    const idB = b.guests[1].id;
    const here = await (await send(`${base}/api/guests/${idB}`, "PATCH", { here: true, role: "Vokalist" })).json();
    assert.deepEqual([here.guests[1].here, here.guests[1].role], [true, "Vokalist"]);
    assert.equal((await send(`${base}/api/guests/findes-ikke`, "PATCH", { here: true })).status, 404);
    const ordered = await (await send(`${base}/api/order`, "PUT", { ids: [idB, a.guests[0].id] })).json();
    assert.deepEqual(ordered.guests.map((g) => g.name), ["Bob Example", "Alice Example"]);
    const out = await (await send(`${base}/api/everyone-out`, "POST")).json();
    assert.ok(out.guests.every((g) => !g.here));
    const planned = await (await send(`${base}/api/plan`, "PATCH", { accent: "violet", kicker: "Gæster" })).json();
    assert.deepEqual([planned.plan.accent, planned.plan.kicker], ["violet", "Gæster"]);
    assert.equal((await (await send(`${base}/api/plan`, "PATCH", { accent: "rød" })).json()).plan.accent, "violet");
    assert.equal(planned.plan.scale, 1);
    const bigger = await (await send(`${base}/api/plan`, "PATCH", { scale: 1.4 })).json();
    assert.deepEqual([bigger.plan.scale, bigger.plan.accent], [1.4, "violet"]);
    assert.equal((await (await send(`${base}/api/plan`, "PATCH", { scale: 50 })).json()).plan.scale, SCALE_MAX);
    assert.equal((await (await send(`${base}/api/plan`, "PATCH", { scale: "stor" })).json()).plan.scale, SCALE_MAX);
    const removed = await (await send(`${base}/api/guests/${idB}`, "DELETE")).json();
    assert.deepEqual(removed.guests.map((g) => g.name), ["Alice Example"]);
    assert.equal((await read(base)).guests.length, 1);
  });
});

test("every open overlay hears about a change straight away", async () => {
  await withGaester("", async (base) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);
    assert.match(await next(), /I studiet nu/);
    await send(`${base}/api/guests`, "POST", { name: "Alice Example", here: true });
    assert.match(await next(), /Alice Example/);
    controller.abort();
  });
});
