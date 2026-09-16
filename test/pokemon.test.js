import test from "node:test";
import assert from "node:assert/strict";
import { CLASSIC_CHASE_CARDS, curateChaseCards, parseCollectrCards, parseTcgGraphCards, RGB_MEW_CARDS } from "../apps/pokemon/app.js";

test("parses Collectr's escaped 30th Celebration card payload", () => {
  const html = String.raw`{\"product_id\":\"696688\",\"catalog_category\":\"3\",\"catalog_group_id\":\"24722\",\"product_name\":\"Mew ex \",\"image_url\":\"https://cdn.example/card.jpg?width=1200\u0026quality=80\",\"card_number\":\"158/128\",\"rarity\":\"Futuristic Rare\",\"product_sub_type\":\"Holofoil\",\"is_card\":true,\"latest_price\":\"1808.2500\"}`;
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

test("keeps all three unpriced RGB Mew chase cards as featured cards", () => {
  assert.deepEqual(RGB_MEW_CARDS.map((card) => card.number), ["R/RGB", "G/RGB", "B/RGB"]);
  assert.equal(RGB_MEW_CARDS.every((card) => card.kind === "chase" && card.featured && !card.price), true);
  assert.equal(new Set(RGB_MEW_CARDS.map((card) => card.image)).size, 3);
});

test("curates 30 cards with the five classics and without regular Greninja ex", () => {
  const main = Array.from({ length: 30 }, (_, index) => ({
    sourceId: `main:${index}`,
    name: index === 0 ? "Greninja ex" : `Main ${index}`,
    number: index === 0 ? "021/128" : `${index}/128`,
    priceValue: 1000 - index
  }));
  const curated = curateChaseCards(main, CLASSIC_CHASE_CARDS);
  assert.equal(curated.length + RGB_MEW_CARDS.length, 30);
  assert.equal(CLASSIC_CHASE_CARDS.every((classic) => curated.some((card) => card.sourceId === classic.sourceId)), true);
  assert.equal(curated.some((card) => card.name === "Greninja ex" && card.number === "021/128"), false);
});
