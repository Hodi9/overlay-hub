import test from "node:test";
import assert from "node:assert/strict";
import { parseCollectrCards } from "../apps/pokemon/app.js";

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
    visible: true,
    source: "Collectr"
  });
});

test("ignores non-30th catalog groups", () => {
  const html = String.raw`{\"product_id\":\"1\",\"catalog_group_id\":\"999\",\"product_name\":\"Other\",\"image_url\":\"x\",\"card_number\":\"1\",\"rarity\":\"Rare\",\"product_sub_type\":\"Holofoil\",\"latest_price\":\"1\"}`;
  assert.deepEqual(parseCollectrCards(html), []);
});
