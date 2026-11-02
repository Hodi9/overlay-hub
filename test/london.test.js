import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { MAX_ITEMS, addItem, advance, cleanItem, cleanPlan, defaultItems, moveNext, reorder, restore, updateItem } from "../apps/london/state.js";
import { createLondonApp } from "../apps/london/app.js";

const titles = (items) => items.map((item) => item.title);
const statuses = (items) => items.map((item) => item.status);
const plan = (...rows) => rows.map(([title, status = "todo", visible = true]) => cleanItem({ title, status, visible }));

test("the first plan is what Aggo and Lucas have said so far", () => {
  const items = defaultItems();
  assert.deepEqual(titles(items), ["London Eye", "Nando's", "Chinatown", "Oxford Street", "Prøv forskellig mad", "Skøjte"]);
  assert.ok(items.every((item) => item.status === "todo" && item.visible));
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
});

test("cleanItem ignores invalid fields and keeps the old title when the new one is empty", () => {
  const item = cleanItem({ title: "  Borough Market  ", maybe: "ja", status: "later", note: "x".repeat(200) });
  assert.deepEqual([item.title, item.maybe, item.status, item.note.length], ["Borough Market", false, "todo", 80]);
  assert.equal(cleanItem({ title: "   " }, item).title, "Borough Market");
  assert.equal(cleanItem({ status: "done", visible: false }, item).status, "done");
});

test("cleanPlan keeps the old headline when the new one is empty but lets the small text be cleared", () => {
  assert.deepEqual(cleanPlan({ kicker: "", title: "  " }, { kicker: "A", title: "B", view: "list" }), { kicker: "", title: "B", view: "list" });
  assert.equal(cleanPlan({ title: "Aggo & Lucas på tur" }).title, "Aggo & Lucas på tur");
});

test("the overlay view is either the whole list or just now and next, and defaults to the list", () => {
  assert.equal(cleanPlan({}).view, "list");
  assert.equal(cleanPlan({ view: "compact" }).view, "compact");
  assert.equal(cleanPlan({ view: "alt" }, { kicker: "A", title: "B", view: "compact" }).view, "compact"); // invalid value: the old one stays
  assert.equal(cleanPlan({ title: "C" }, { kicker: "A", title: "B", view: "compact" }).view, "compact"); // saving the headline does not reset it
  assert.equal(restore({ plan: { view: "compact" }, items: [] }).plan.view, "compact");
  assert.equal(restore({ plan: { title: "Gemt" }, items: [] }).plan.view, "list"); // state saved before the setting existed
});

test("only one thing is running now", () => {
  let items = plan(["a", "now"], ["b"], ["c"]);
  items = updateItem(items, items[2].id, { status: "now" });
  assert.deepEqual(statuses(items), ["todo", "todo", "now"]);
  assert.equal(updateItem(items, "findes-ikke", { status: "done" }), null);
  const added = addItem(items, { title: "d", status: "now" });
  assert.deepEqual(statuses(added.items).filter((s) => s === "now").length, 1);
});

test("a new thing goes last, or next after what is running", () => {
  const items = plan(["a", "done"], ["b", "now"], ["c"], ["d"]);
  assert.deepEqual(titles(addItem(items, { title: "x" }).items), ["a", "b", "c", "d", "x"]);
  assert.deepEqual(titles(addItem(items, { title: "x" }, "next").items), ["a", "b", "x", "c", "d"]);
  const idle = plan(["a", "done"], ["b", "done"], ["c"], ["d"]);
  assert.deepEqual(titles(addItem(idle, { title: "x" }, "next").items), ["a", "b", "x", "c", "d"]); // in front of what is still to do
  assert.deepEqual(titles(addItem(plan(["a", "done"]), { title: "x" }, "next").items), ["a", "x"]);
  assert.equal(addItem(items, { title: "   " }), null);
  assert.equal(addItem(Array.from({ length: MAX_ITEMS }, () => cleanItem({ title: "y" })), { title: "x" }), null);
});

test("starting something right now sends the interrupted thing back in the queue, right after it", () => {
  const items = plan(["a", "now"], ["b"]);
  const { items: next } = addItem(items, { title: "spontaneous", status: "now" }, "next");
  assert.deepEqual([titles(next).join(), statuses(next).join()], ["spontaneous,a,b", "now,todo,todo"]);
});

test("moveNext puts an existing thing right after what is running", () => {
  const items = plan(["a", "now"], ["b"], ["c"], ["d"]);
  assert.deepEqual(titles(moveNext(items, items[3].id)), ["a", "d", "b", "c"]);
  assert.deepEqual(titles(moveNext(items, items[0].id)), ["a", "b", "c", "d"]); // the running thing stays where it is
  assert.equal(moveNext(items, "findes-ikke"), items);
});

test("advance finishes the running thing and starts the next one that is shown", () => {
  let items = plan(["a", "now"], ["b", "todo", false], ["c"], ["d"]);
  items = advance(items);
  assert.deepEqual(statuses(items), ["done", "todo", "now", "todo"]); // the hidden one is skipped
  items = advance(advance(items));
  assert.deepEqual(statuses(items), ["done", "todo", "done", "done"]); // nothing more shown: all that is left is hidden
  assert.deepEqual(statuses(advance(plan(["a"], ["b"]))), ["now", "todo"]); // nothing running: start the first
  assert.deepEqual(statuses(advance(plan(["a", "todo"], ["b", "now"]))), ["now", "done"]); // nothing after it: go back to what was skipped
});

test("reorder follows the list it is given and keeps whatever was left out", () => {
  const items = plan(["a"], ["b"], ["c"]);
  assert.deepEqual(titles(reorder(items, [items[2].id, items[0].id])), ["c", "a", "b"]);
  assert.deepEqual(titles(reorder(items, [items[1].id, items[1].id, "x"])), ["b", "a", "c"]);
  assert.deepEqual(titles(reorder(items, "nonsense")), ["a", "b", "c"]);
});

test("restore reads saved state and shrugs off garbage", () => {
  assert.deepEqual(restore(null).items, []);
  const saved = restore({ plan: { title: "Gemt" }, items: [{ id: "1", title: "a", status: "now" }, { id: "2", title: "" }, null, { id: "3", title: "c", status: "now" }] });
  assert.equal(saved.plan.title, "Gemt");
  assert.deepEqual([titles(saved.items).join(), saved.items.map((i) => i.id).join(), statuses(saved.items).join()], ["a,c", "1,3", "todo,now"]);
});

async function withLondon(password, fn) {
  const old = process.env.LONDON_CONTROL_PASSWORD;
  if (password) process.env.LONDON_CONTROL_PASSWORD = password; else delete process.env.LONDON_CONTROL_PASSWORD;
  const app = express();
  app.use("/london", createLondonApp());
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}/london`); } finally {
    server.close();
    if (old === undefined) delete process.env.LONDON_CONTROL_PASSWORD; else process.env.LONDON_CONTROL_PASSWORD = old;
  }
}
const send = (url, method, body, key) => fetch(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(key ? { "x-london-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (base) => (await fetch(`${base}/api/state`)).json();

test("the panel API needs the password, the overlay does not", async () => {
  await withLondon("hemmelig", async (base) => {
    assert.equal((await send(`${base}/api/items`, "POST", { title: "x" })).status, 401);
    assert.equal((await send(`${base}/api/items`, "POST", { title: "x" }, "forkert")).status, 401);
    assert.equal((await send(`${base}/api/login`, "POST", {}, "hemmelig")).status, 200);
    assert.equal((await send(`${base}/api/items`, "POST", { title: "Borough Market" }, "hemmelig")).status, 200);
    const state = await read(base);
    assert.equal(state.items.at(-1).title, "Borough Market");
    assert.equal(state.passwordRequired, true);
    assert.match((await fetch(`${base}/api/state`)).headers.get("x-robots-tag"), /noindex/);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/control.html`)).status, 200);
  });
});

test("adding, starting, finishing and removing through the API", async () => {
  await withLondon("", async (base) => {
    const first = await read(base);
    assert.equal(first.passwordRequired, false);
    assert.equal(first.plan.title, "POWER TRIP: Aggo & Lucas");
    assert.equal((await send(`${base}/api/items`, "POST", { title: "   " })).status, 400);
    const start = await (await send(`${base}/api/advance`, "POST")).json();
    assert.deepEqual([start.items[0].status, start.items[1].status], ["now", "todo"]);
    const added = await (await send(`${base}/api/items`, "POST", { title: "Camden", position: "next", maybe: true })).json();
    assert.deepEqual(titles(added.items).slice(0, 3), ["London Eye", "Camden", "Nando's"]);
    const patched = await (await send(`${base}/api/items/${added.items[1].id}`, "PATCH", { status: "now", note: "spontan" })).json();
    assert.deepEqual(statuses(patched.items).slice(0, 3), ["todo", "now", "todo"]);
    assert.equal((await send(`${base}/api/items/findes-ikke`, "PATCH", { status: "done" })).status, 404);
    const moved = await (await send(`${base}/api/items/${patched.items[4].id}/next`, "POST")).json();
    assert.deepEqual(titles(moved.items).slice(0, 3), ["London Eye", "Camden", "Oxford Street"]);
    const ids = moved.items.map((item) => item.id).reverse();
    assert.equal((await (await send(`${base}/api/order`, "PUT", { ids })).json()).items[0].title, "Skøjte");
    const planned = await (await send(`${base}/api/plan`, "PATCH", { title: "Lucas & Aggo" })).json();
    assert.equal(planned.plan.title, "Lucas & Aggo");
    assert.equal(planned.plan.view, "list");
    const compact = await (await send(`${base}/api/plan`, "PATCH", { view: "compact" })).json();
    assert.deepEqual([compact.plan.view, compact.plan.title], ["compact", "Lucas & Aggo"]);
    assert.equal((await (await send(`${base}/api/plan`, "PATCH", { view: "noget andet" })).json()).plan.view, "compact");
    const reset = await (await send(`${base}/api/reset`, "POST")).json();
    assert.ok(reset.items.every((item) => item.status === "todo"));
    const removed = await (await send(`${base}/api/items/${reset.items[0].id}`, "DELETE")).json();
    assert.equal(removed.items.length, reset.items.length - 1);
    assert.equal((await read(base)).items.length, removed.items.length);
  });
});

test("every open overlay hears about a change straight away", async () => {
  await withLondon("", async (base) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);
    assert.match(await next(), /London Eye/);
    await send(`${base}/api/items`, "POST", { title: "Tower Bridge" });
    assert.match(await next(), /Tower Bridge/);
    controller.abort();
  });
});
