import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { CHASE_LIST_SIZE, createPokemonApp, curateChaseCards, markChaseHits, parseCollectrCards, parsePrice, parseTcgGraphCards, sessionStats } from "../apps/pokemon/app.js";

test("prices typed by hand become numbers", () => {
  assert.equal(parsePrice("$1,234.56"), 1234.56);
  assert.equal(parsePrice("49,99 €"), 49.99);
  assert.equal(parsePrice("$4,263"), 4263);
  assert.equal(parsePrice("1.234,50 kr"), 1234.5);
  assert.equal(parsePrice(""), 0);
  assert.equal(parsePrice("gratis"), 0);
});

test("a chase card is hit when a hit came from it or has the same name and number", () => {
  const chase = [{ sourceId: "1", name: "Mew ex", number: "152/128" }, { sourceId: "2", name: "Lugia", number: "149/147" }, { sourceId: "3", name: "Pikachu ex", number: "150/128" }];
  const pulls = [{ fromSourceId: "1" }, { name: "lugia ", number: "149/147" }, { name: "Pikachu ex", number: "149/128" }];
  assert.deepEqual(markChaseHits(chase, pulls).map((c) => c.hit), [true, true, false]);
});

test("session stats count packs and only the hits since the session started", () => {
  const session = { packs: 7, startedAt: "2026-11-18T18:00:00Z" };
  const pulls = [
    { name: "Old", priceValue: 999, addedAt: "2026-11-17T18:00:00Z" },
    { name: "Mew ex", number: "152/128", price: "$57.25", priceValue: 57.25, addedAt: "2026-11-18T18:30:00Z" },
    { name: "Lapras", priceValue: 3.04, addedAt: "2026-11-18T18:40:00Z" },
    { name: "No date", priceValue: 50 }
  ];
  const s = sessionStats(session, pulls);
  assert.deepEqual([s.packs, s.hits, s.value, s.valueText], [7, 2, 60.29, "$60.29"]);
  assert.deepEqual([s.best.name, s.best.price], ["Mew ex", "$57.25"]);
  assert.equal(sessionStats({ packs: 0, startedAt: "2026-11-19T00:00:00Z" }, pulls).best, null);
});

test("parses Collectr's escaped 30th Celebration card payload", () => {
  const html = String.raw`{\"product_id\":\"696688\",\"catalog_category\":\"3\",\"catalog_group_id\":\"24722\",\"product_name\":\"Mew ex \",\"image_url\":\"https://cdn.example/card.jpg?width=1200&quality=80\",\"card_number\":\"158/128\",\"rarity\":\"Futuristic Rare\",\"product_sub_type\":\"Holofoil\",\"is_card\":true,\"latest_price\":\"1808.2500\"}`;
  const cards = parseCollectrCards(html);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], {
    id: "collectr-696688",
    sourceId: "696688",
    setId: "30th-celebration",
    name: "Mew ex",
    image: "https://cdn.example/card.jpg?width=1200&quality=80",
    number: "158/128",
    rarity: "Futuristic Rare",
    finish: "Holofoil",
    price: "$1,808.25",
    priceValue: 1808.25,
    kind: "chase",
    visible: true,
    source: "Collectr"
  });
});

test("ignores non-30th catalog groups", () => {
  const html = String.raw`{\"product_id\":\"1\",\"catalog_group_id\":\"999\",\"product_name\":\"Other\",\"image_url\":\"x\",\"card_number\":\"1\",\"rarity\":\"Rare\",\"product_sub_type\":\"Holofoil\",\"latest_price\":\"1\"}`;
  assert.deepEqual(parseCollectrCards(html), []);
});

test("maps and sorts Cardmarket EUR prices from TCGGraph", () => {
  const cards = parseTcgGraphCards({
    meta: { priceSource: "cardmarket" },
    data: [
      {
        id: "pkm_30c_2",
        name: "Pikachu ex",
        collectorNumber: "150/128",
        rarity: "Special Illustration Rare",
        images: { large: { webp: "https://cdn.example/pikachu.webp" } },
        prices: [
          { source: "tcgplayer", currency: "USD", market: 900 },
          { source: "cardmarket", currency: "EUR", finish: "foil", market: 380 }
        ]
      },
      {
        id: "pkm_30c_1",
        name: "Charizard",
        collectorNumber: "4/102",
        rarity: "Rare Holo",
        images: { normal: "https://cdn.example/charizard.webp" },
        prices: [{ source: "cardmarket", currency: "EUR", finish: "foil", trend: 450 }]
      }
    ]
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, "Charizard");
  assert.equal(cards[0].priceValue, 450);
  assert.match(cards[0].price, /450/);
  assert.equal(cards[0].source, "Cardmarket");
  assert.equal(cards[1].image, "https://cdn.example/pikachu.webp");
});

test("the chase list is just the 30 most expensive cards, main set and Classic Collection together", () => {
  const main = Array.from({ length: 40 }, (_, i) => ({ sourceId: String(i), name: `Main ${i}`, priceValue: 100 - i }));
  const classic = [{ sourceId: "classic:1", name: "Lugia", priceValue: 99.5 }, { sourceId: "classic:2", name: "Dark Tyranitar", priceValue: 1 }];
  const list = curateChaseCards(main, classic);
  assert.equal(list.length, CHASE_LIST_SIZE);
  assert.deepEqual(list.slice(0, 3).map((c) => c.name), ["Main 0", "Lugia", "Main 1"]);
  assert.ok(!list.some((c) => c.name === "Dark Tyranitar"), "a cheap classic is not forced in");
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].priceValue >= list[i].priceValue);
});

test("removed cards stay out and the next one moves up; duplicates count once", () => {
  const main = Array.from({ length: 35 }, (_, i) => ({ sourceId: String(i), priceValue: 100 - i }));
  const list = curateChaseCards([...main, main[0]], [], new Set(["0", "1"]));
  assert.equal(list.length, CHASE_LIST_SIZE);
  assert.deepEqual([list[0].sourceId, list.at(-1).sourceId], ["2", "31"]);
});

// Collectr's escaped page payload for rows of [id, name, number, price].
function collectrPage(rows, group = "24722") {
  const q = '\\"';
  return rows.map(([id, name, number, price]) =>
    `{${q}product_id${q}:${q}${id}${q},${q}catalog_group_id${q}:${q}${group}${q},${q}product_name${q}:${q}${name}${q},` +
    `${q}image_url${q}:${q}https://cdn.example/${id}.jpg${q},${q}card_number${q}:${q}${number}${q},${q}rarity${q}:${q}Rare${q},` +
    `${q}product_sub_type${q}:${q}Holofoil${q},${q}latest_price${q}:${q}${price}${q}}`
  ).join(",");
}

test("a deleted chase card stays deleted after a refresh, there are no RGB Mew duplicates, and restore brings it back", async () => {
  const main = Array.from({ length: 34 }, (_, i) => [String(1000 + i), i === 0 ? "Mew" : `Card ${i}`, i === 0 ? "R/RGB" : `${i}/128`, String(500 - i)]);
  const classic = [["2000", "Lugia", "149/147", "499.5"]]; // between Mew (500) and Card 1 (499)
  const fetchImpl = async (url) => new Response(String(url).includes("classic") ? collectrPage(classic, "24837") : collectrPage(main));
  const router = createPokemonApp({ controlPassword: "pw", fetchImpl, disableDatabase: true, refreshIntervalMs: 1e9 });
  const app = express();
  app.use("/pokemon", router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/pokemon/api`;
  const call = async (method, path) => (await fetch(base + path, { method, headers: { "x-pokemon-key": "pw" } })).json();
  const chase = () => call("GET", "/state?set=30th-celebration&view=chase");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  try {
    await settle(); // the first import runs on start
    let s = await chase();
    assert.equal(s.cards.length, CHASE_LIST_SIZE);
    assert.ok(!s.cards.some((c) => /^featured-/.test(c.id)), "no hand-added RGB Mews");
    assert.equal(s.cards.filter((c) => c.number === "R/RGB").length, 1, "the RGB Mew is there once");
    assert.equal(s.cards[1].name, "Lugia", "classics are ranked by price with the rest");

    const mew = s.cards.find((c) => c.number === "R/RGB");
    s = await call("DELETE", `/cards/${mew.id}`);
    assert.equal(s.removedCount, 1);
    await settle(); // the refill runs after the delete
    await call("POST", "/import/30th"); // a later price refresh
    s = await chase();
    assert.equal(s.cards.length, CHASE_LIST_SIZE, "the next card moved up");
    assert.ok(!s.cards.some((c) => c.number === "R/RGB"), "the deleted card did not come back");

    s = await call("POST", "/chase/restore");
    assert.equal(s.removedCount, 0);
    assert.ok(s.cards.some((c) => c.number === "R/RGB"));

    // "Ramt" on a chase card: it becomes a hit, is marked on the chase list, and is the latest hit for the reveal.
    const lugia = s.cards.find((c) => c.name === "Lugia");
    s = await call("POST", `/cards/${lugia.id}/hit`);
    assert.equal(s.lastHit.id, s.cards.find((c) => c.name === "Lugia").id);
    assert.deepEqual([s.session.hits, s.session.value, s.session.best.name], [1, 499.5, "Lugia"]);
    s = await chase();
    assert.equal(s.chaseHits, 1);
    assert.equal(s.cards.find((c) => c.name === "Lugia").hit, true);

    // Packs count up and down (never below 0); a new session starts over but keeps the hits.
    const post = async (path, body) => (await fetch(base + path, { method: "POST", headers: { "x-pokemon-key": "pw", "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })).json();
    await post("/session/pack", { by: 1 });
    s = await post("/session/pack", { by: 1 });
    assert.equal(s.session.packs, 2);
    await post("/session/pack", { by: -1 });
    await post("/session/pack", { by: -1 });
    s = await post("/session/pack", { by: -1 });
    assert.equal(s.session.packs, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    s = await post("/session/new");
    assert.deepEqual([s.session.packs, s.session.hits], [0, 0]);
    assert.equal(s.cards.length, 1, "the hit itself stays");

    // A hand-added hit with a typed price counts in the session; a silent one (browser backup restore) does not play the reveal.
    const before = s.lastHit;
    s = await post("/cards", { kind: "pull", name: "Restored", price: "$5", silent: true, addedAt: "2026-01-01T00:00:00Z" });
    assert.deepEqual(s.lastHit, before);
    s = await post("/cards", { kind: "pull", name: "Pikachu ex", price: "$38.23" });
    assert.equal(s.lastHit.id, s.cards.find((c) => c.name === "Pikachu ex").id);
    assert.deepEqual([s.session.hits, s.session.value], [1, 38.23]);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
