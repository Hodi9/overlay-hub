import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  MAX_ENTRANTS, addEntrant, bracketSize, buildBracket, champion, cleanEntrant, cleanPlan, liveMatch,
  reorder, restore, seedOrder, setResult, shuffle
} from "../apps/turnering/state.js";
import { createTurneringApp } from "../apps/turnering/app.js";

const make = (...names) => names.map((name) => cleanEntrant({ name }));
const pairs = (entrants, rounds, round = 0) => {
  const name = (id) => entrants.find((entrant) => entrant.id === id)?.name ?? null;
  return rounds[round].map((match) => [name(match.a), name(match.b)]);
};
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("the bracket is as small as everyone fits in, and the seeds stand so 1 and 2 only meet in the final", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 8, 9, 16, 40].map(bracketSize), [2, 2, 2, 4, 4, 8, 8, 16, 16, 16]);
  assert.deepEqual(seedOrder(2), [1, 2]);
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.deepEqual([...seedOrder(16)].sort((a, b) => a - b), Array.from({ length: 16 }, (_v, i) => i + 1));
});

test("first round pairs the best with the worst, and the best seeds sit out when the bracket is not full", () => {
  const eight = make("A", "B", "C", "D", "E", "F", "G", "H");
  const full = buildBracket(eight);
  assert.deepEqual(full.map((round) => round.length), [4, 2, 1]);
  assert.deepEqual(pairs(eight, full), [["A", "H"], ["D", "E"], ["B", "G"], ["C", "F"]]);

  const six = make("A", "B", "C", "D", "E", "F");
  const rounds = buildBracket(six);
  assert.deepEqual(pairs(six, rounds), [["A", null], ["D", "E"], ["B", null], ["C", "F"]]);
  assert.deepEqual(rounds[0].map((match) => match.bye), [true, false, true, false]);
  // The two who sit out are already in the semifinals.
  assert.deepEqual(pairs(six, rounds, 1), [["A", null], ["B", null]]);
  assert.equal(buildBracket(make("A"))[0][0].bye, true);
  assert.deepEqual(buildBracket([]).map((round) => round.length), [1]);
});

test("a best-of match is decided when one side has the wins needed, and opens again when a point is taken back", () => {
  const four = make("A", "B", "C", "D");
  let results = setResult(four, {}, "r0m0", { a: 1 }, 3);
  assert.equal(buildBracket(four, results)[0][0].winner, null);
  results = setResult(four, results, "r0m0", { a: 2 }, 3);
  let rounds = buildBracket(four, results);
  assert.equal(rounds[0][0].winner, four[0].id);
  assert.equal(rounds[1][0].a, four[0].id);
  assert.equal(rounds[1][0].b, null);

  results = setResult(four, results, "r0m0", { a: 1 }, 3);
  rounds = buildBracket(four, results);
  assert.deepEqual([rounds[0][0].winner, rounds[0][0].scoreA, rounds[1][0].a], [null, 1, null]);

  // Scores stay inside 0–99 and anything that is not a number is ignored.
  results = setResult(four, results, "r0m0", { a: -4, b: "tre" }, 3);
  assert.deepEqual([results.r0m0.a, results.r0m0.b], [0, 0]);
  assert.equal(setResult(four, results, "r0m0", { b: 500 }, 0).r0m0.b, 99);
});

test("a free score needs a winner by hand; a winner by hand also works for a forfeit", () => {
  const four = make("A", "B", "C", "D");
  let results = setResult(four, {}, "r0m1", { a: 13, b: 7 }, 0);
  assert.equal(buildBracket(four, results)[0][1].winner, null);
  results = setResult(four, results, "r0m1", { winner: "a" }, 0);
  assert.equal(buildBracket(four, results)[0][1].winner, four[1].id);
  // A later score change in a free match keeps the winner.
  results = setResult(four, results, "r0m1", { b: 9 }, 0);
  assert.deepEqual([results.r0m1.b, results.r0m1.winner], [9, "a"]);
  // Forfeit in a best-of match, at 0–0.
  results = setResult(four, results, "r0m0", { winner: "b" }, 3);
  assert.equal(buildBracket(four, results)[0][0].winner, four[3].id);
  assert.equal(setResult(four, results, "r0m0", { winner: "" }, 3).r0m0.winner, "");
});

test("a match without two entrants cannot get a result", () => {
  const four = make("A", "B", "C", "D");
  assert.equal(setResult(four, {}, "r1m0", { a: 1 }, 3), null);
  assert.equal(setResult(four, {}, "findes-ikke", { a: 1 }, 3), null);
  assert.equal(setResult(make("A", "B", "C"), {}, "r0m0", { a: 1 }, 3), null); // a free pass
});

test("changing an earlier match starts the matches after it over", () => {
  const four = make("A", "B", "C", "D");
  let results = setResult(four, {}, "r0m0", { winner: "a" }, 1);
  results = setResult(four, results, "r0m1", { winner: "a" }, 1);
  results = setResult(four, results, "r1m0", { a: 1 }, 1);
  let rounds = buildBracket(four, results);
  assert.equal(champion(rounds), four[0].id);

  // The first semifinal goes the other way: the final has a new entrant and no result.
  results = setResult(four, results, "r0m0", { winner: "b" }, 1);
  rounds = buildBracket(four, results);
  assert.deepEqual([rounds[1][0].a, rounds[1][0].scoreA, rounds[1][0].winner], [four[3].id, 0, null]);
  assert.equal(champion(rounds), null);
  assert.equal(results.r1m0, undefined);
});

test("the live match is the picked one while it is open, otherwise the next one that can be played", () => {
  const four = make("A", "B", "C", "D");
  assert.equal(liveMatch(buildBracket(four)), "r0m0");
  assert.equal(liveMatch(buildBracket(four), "r0m1"), "r0m1");
  assert.equal(liveMatch(buildBracket(four), "r1m0"), "r0m0"); // the final has no entrants yet
  let results = setResult(four, {}, "r0m1", { winner: "b" }, 1);
  assert.equal(liveMatch(buildBracket(four, results), "r0m1"), "r0m0");
  results = setResult(four, results, "r0m0", { winner: "a" }, 1);
  assert.equal(liveMatch(buildBracket(four, results)), "r1m0");
  results = setResult(four, results, "r1m0", { winner: "a" }, 1);
  assert.equal(liveMatch(buildBracket(four, results)), "");
  assert.equal(liveMatch(buildBracket(make("A"))), "");
});

test("entrants: a name is needed, the list stops at the limit, and order and shuffle keep everyone", () => {
  assert.equal(addEntrant([], { name: "  " }), null);
  assert.equal(addEntrant(make(...Array.from({ length: MAX_ENTRANTS }, (_v, i) => `T${i}`)), { name: "En til" }), null);
  const added = addEntrant([], { name: "  Team Example  ", tag: "x".repeat(90), logo: "hacked" });
  assert.deepEqual([added.entrant.name, added.entrant.tag.length, added.entrant.logo], ["Team Example", 40, ""]);
  const three = make("A", "B", "C");
  assert.deepEqual(reorder(three, [three[2].id, "x"]).map((entrant) => entrant.name), ["C", "A", "B"]);
  let n = 0;
  const mixed = shuffle(three, () => [0.1, 0.9][n++ % 2]);
  assert.deepEqual(mixed.map((entrant) => entrant.name).sort(), ["A", "B", "C"]);
  assert.notDeepEqual(mixed.map((entrant) => entrant.name), ["A", "B", "C"]);
});

test("the plan ignores unknown values, and saved state is read back without trusting it", () => {
  const plan = cleanPlan({ title: "  Dreamglow Cup ", bestOf: 4, lang: "fr", accent: "neon", scale: 9 });
  assert.deepEqual([plan.title, plan.bestOf, plan.lang, plan.accent, plan.scale], ["Dreamglow Cup", 3, "da", "lime", 2]);
  assert.equal(cleanPlan({ bestOf: 0 }).bestOf, 0);

  const four = make("A", "B", "C", "D");
  const results = setResult(four, {}, "r0m0", { a: 2 }, 3);
  const back = restore(JSON.parse(JSON.stringify({ plan: { title: "Cup" }, entrants: [...four, { name: "" }, null], results: { ...results, r1m0: { ids: ["x", "y"], a: 5, b: 1, winner: "a" }, junk: 7 } })));
  assert.equal(back.entrants.length, 4);
  assert.deepEqual(Object.keys(back.results), ["r0m0"]);
  assert.equal(buildBracket(back.entrants, back.results)[0][0].winner, four[0].id);
  assert.deepEqual(restore(null), { plan: cleanPlan(), entrants: [], results: {} });
});

async function serve(context) {
  const app = express();
  app.use("/turnering", createTurneringApp(context));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/turnering/api`;
  const call = async (path, method = "GET", body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: response.headers.get("content-type")?.includes("json") ? await response.json() : null, response };
  };
  return { call, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test("the panel's requests: entrants, scores, a locked draw once a match has a result, logos and reset", async () => {
  const { call, close } = await serve();
  try {
    for (const name of ["A", "B", "C", "D"]) assert.equal((await call("/entrants", "POST", { name })).status, 200);
    let { data } = await call("/state");
    assert.deepEqual([data.entrants.length, data.rounds.length, data.live, data.started, data.champion], [4, 2, "r0m0", false, null]);
    const [a] = data.entrants;

    ({ data } = await call("/matches/r0m0", "PATCH", { a: 2 }));
    assert.deepEqual([data.rounds[0][0].winner, data.started, data.live], [a.id, true, "r0m1"]);
    assert.equal((await call("/matches/r1m0", "PATCH", { a: 1 })).status, 400);

    // The draw is locked, but a name can still be corrected.
    assert.equal((await call("/entrants", "POST", { name: "E" })).status, 409);
    assert.equal((await call("/shuffle", "POST", {})).status, 409);
    assert.equal((await call(`/entrants/${a.id}`, "DELETE")).status, 409);
    assert.equal((await call(`/entrants/${a.id}`, "PATCH", { name: "Alpha" })).data.entrants[0].name, "Alpha");

    assert.equal((await call(`/entrants/${a.id}/logo`, "PUT", { dataUrl: "data:text/html;base64,PGI+" })).status, 400);
    ({ data } = await call(`/entrants/${a.id}/logo`, "PUT", { dataUrl: PNG }));
    assert.match(data.entrants[0].logo, /^[0-9a-f]{10}$/);
    const logo = await call(`/logo/${a.id}`);
    assert.deepEqual([logo.status, logo.response.headers.get("content-type")], [200, "image/png"]);
    assert.equal((await call("/logo/findes-ikke")).status, 404);

    ({ data } = await call("/plan", "PATCH", { live: "r0m1", bestOf: 1 }));
    assert.equal(data.live, "r0m1");
    ({ data } = await call("/reset", "POST", {}));
    assert.deepEqual([data.started, data.entrants.length, data.plan.live], [false, 4, ""]);
    ({ data } = await call("/clear", "POST", {}));
    assert.equal(data.entrants.length, 0);
    assert.equal((await call(`/logo/${a.id}`)).status, 404);
  } finally {
    await close();
  }
});

test("a channel's tournament is only changed with that channel's key", async () => {
  const { call, close } = await serve({ stateId: "kanal", authorizeControl: (request) => request.headers["x-channel-key"] === "rigtig" });
  try {
    assert.equal((await call("/entrants", "POST", { name: "A" })).status, 401);
    const { status, data } = await call("/entrants", "POST", { name: "A" }, { "x-channel-key": "rigtig" });
    assert.deepEqual([status, data.entrants.length, data.passwordRequired], [200, 1, false]);
    assert.equal((await call("/state")).status, 200);
  } finally {
    await close();
  }
});
