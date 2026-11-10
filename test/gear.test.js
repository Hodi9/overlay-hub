import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { MAX_PRODUCTS, addProduct, cleanCommand, cleanPlan, cleanProduct, commandFor, reorder, restore, updateProduct } from "../apps/gear/state.js";
import { formatPrice, isPrivateAddress, parseProductPage } from "../apps/gear/fetchProduct.js";
import { imageFromDataUrl, packImages, unpackImages } from "../apps/_lib/images.js";
import { createGearApp } from "../apps/gear/app.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("a product needs a name, gets a chat command from it, and keeps the old name when the new one is empty", () => {
  const product = cleanProduct({ brand: " Logitech ", name: "G PRO X2 gaming mus", price: "1.399 kr.", url: "javascript:alert(1)", image: "hacked" });
  assert.deepEqual([product.brand, product.command, product.url, product.image], ["Logitech", "!mus", "", ""]);
  assert.equal(cleanProduct({ name: "  " }, product).name, "G PRO X2 gaming mus");
  assert.equal(cleanProduct({ command: "kamera nu" }, product).command, "!kameranu");
  assert.equal(cleanProduct({ url: "https://shop.example/p/1" }, product).url, "https://shop.example/p/1");
  assert.equal(commandFor("Odyssey OLED G6 27” gamingskærm"), "!gamingskaerm");
  assert.equal(commandFor(""), "!gear");
  assert.deepEqual([cleanCommand("!!mus"), cleanCommand("   "), cleanCommand("x".repeat(60)).length], ["!mus", "", 21]);
});

test("the list stops at the limit; updating and reordering", () => {
  assert.equal(addProduct([], { name: "" }), null);
  const full = Array.from({ length: MAX_PRODUCTS }, (_v, i) => cleanProduct({ name: `P${i}` }));
  assert.equal(addProduct(full, { name: "En til" }), null);
  const three = full.slice(0, 3);
  assert.equal(updateProduct(three, three[1].id, { before: "999 kr." })[1].before, "999 kr.");
  assert.equal(updateProduct(three, "findes-ikke", {}), null);
  assert.deepEqual(reorder(three, [three[2].id]).map((product) => product.name), ["P2", "P0", "P1"]);
});

test("the plan keeps its numbers inside their limits, and saved state is read back without trusting it", () => {
  const plan = cleanPlan({ showSeconds: 500, everyMinutes: 0, scale: 0.1, accent: "neon", outroEnabled: "ja", shop: "  Power.dk ", portrait: "hacked" });
  assert.deepEqual([plan.showSeconds, plan.everyMinutes, plan.scale, plan.accent, plan.outroEnabled, plan.shop, plan.portrait], [30, 1, 0.5, "orange", false, "Power.dk", ""]);
  const back = restore({ plan: { portrait: "abc1234567", shop: "Shop" }, products: [{ id: "p1", name: "Mus", image: "def1234567" }, { name: "" }, 7] });
  assert.deepEqual([back.plan.portrait, back.products.length, back.products[0].id, back.products[0].image], ["abc1234567", 1, "p1", "def1234567"]);
  assert.deepEqual(restore(null).products, []);
});

test("a product page is read from its schema.org data, or from its share title when there is none", () => {
  const page = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},
    {"@type":["Product"],"name":"Titan Pro &amp; mere","brand":{"@type":"Brand","name":"Cepter"},"image":["/img/titan.jpg"],
     "offers":{"@type":"Offer","price":"1298.00","priceCurrency":"DKK","priceSpecification":{"priceType":"https://schema.org/StrikethroughPrice","price":1599}}}]}</script></head></html>`;
  assert.deepEqual(parseProductPage(page, "https://shop.example/p/titan"), { brand: "Cepter", name: "Titan Pro & mere", price: "1.298 kr.", before: "1.599 kr.", imageUrl: "https://shop.example/img/titan.jpg" });

  const plain = `<html><head><script type="application/ld+json">{ikke json</script><meta property="og:title" content="Osmo Pocket 3"><meta content="https://cdn.example/osmo.png" property="og:image"></head></html>`;
  assert.deepEqual(parseProductPage(plain, "https://shop.example/x"), { brand: "", name: "Osmo Pocket 3", price: "", before: "", imageUrl: "https://cdn.example/osmo.png" });
  assert.throws(() => parseProductPage("<html><body>404</body></html>", "https://shop.example/x"), /intet produkt/);

  assert.deepEqual([formatPrice(1298), formatPrice("49.5", "EUR"), formatPrice(20, "usd"), formatPrice(0), formatPrice("gratis")], ["1.298 kr.", "49,50 €", "$20", "", ""]);
});

test("addresses on the server's own network are refused when fetching from a link", () => {
  for (const address of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "ikke-en-adresse"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["93.184.216.34", "172.32.0.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
});

test("pictures: only real picture types within the size limit, and they survive being saved", () => {
  const image = imageFromDataUrl(PNG);
  assert.deepEqual([image.type, image.version.length], ["image/png", 10]);
  assert.equal(imageFromDataUrl("data:image/svg+xml;base64,PHN2Zz4="), null);
  assert.equal(imageFromDataUrl(PNG, 10), null);
  assert.equal(imageFromDataUrl("https://example.com/a.png"), null);
  const back = unpackImages(JSON.parse(JSON.stringify(packImages(new Map([["p1", image]])))));
  assert.equal(back.get("p1").version, image.version);
  assert.equal(unpackImages({ p1: { type: "text/html", data: "PGI+" }, p2: null }).size, 0);
});

async function serve(context) {
  const app = express();
  app.use("/gear", createGearApp(context));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/gear/api`;
  const call = async (path, method = "GET", body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: response.headers.get("content-type")?.includes("json") ? await response.json() : null, response };
  };
  return { call, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test("the panel's requests: products by hand and from a link, pictures, order and the plan", async () => {
  const picture = Buffer.from(PNG.split(",")[1], "base64");
  const fetchProduct = async (url) => {
    if (url.includes("findes-ikke")) throw new Error("Fandt intet produkt på den side.");
    return { brand: "Cepter", name: "Titan Pro tastatur", price: "1.298 kr.", before: "", url, picture };
  };
  const { call, close } = await serve({ fetchProduct });
  try {
    assert.equal((await call("/products", "POST", {})).status, 400);
    let { data } = await call("/products", "POST", { name: "G PRO mus", brand: "Logitech", price: "1.399 kr." });
    assert.deepEqual([data.products.length, data.products[0].command, data.products[0].image], [1, "!mus", ""]);
    const mouse = data.products[0];

    assert.equal((await call("/products", "POST", { url: "https://shop.example/findes-ikke" })).status, 422);
    ({ data } = await call("/products", "POST", { url: "https://shop.example/p/titan" }));
    const keyboard = data.products[1];
    assert.deepEqual([keyboard.name, keyboard.command, keyboard.url], ["Titan Pro tastatur", "!tastatur", "https://shop.example/p/titan"]);
    assert.match(keyboard.image, /^[0-9a-f]{10}$/);
    const file = await call(`/image/${keyboard.id}`);
    assert.deepEqual([file.status, file.response.headers.get("content-type")], [200, "image/png"]);

    // "Opdatér fra link" keeps the command; a product typed by hand has no link to update from.
    await call(`/products/${keyboard.id}`, "PATCH", { command: "!keyboard", price: "999 kr." });
    ({ data } = await call(`/products/${keyboard.id}`, "PATCH", { refresh: true }));
    assert.deepEqual([data.products[1].command, data.products[1].price], ["!keyboard", "1.298 kr."]);
    assert.equal((await call(`/products/${mouse.id}`, "PATCH", { refresh: true })).status, 400);

    assert.equal((await call(`/products/${mouse.id}/image`, "PUT", { dataUrl: "data:text/html;base64,PGI+" })).status, 400);
    ({ data } = await call(`/products/${mouse.id}/image`, "PUT", { dataUrl: PNG }));
    assert.match(data.products[0].image, /^[0-9a-f]{10}$/);
    ({ data } = await call("/portrait", "PUT", { dataUrl: PNG }));
    assert.match(data.plan.portrait, /^[0-9a-f]{10}$/);
    // Changing the texts does not lose the portrait.
    ({ data } = await call("/plan", "PATCH", { shop: "Power.dk", outroEnabled: true, portrait: "" }));
    assert.deepEqual([data.plan.shop, data.plan.outroEnabled, data.plan.portrait.length], ["Power.dk", true, 10]);
    assert.equal((await call("/portrait", "PUT", { dataUrl: "" })).data.plan.portrait, "");

    ({ data } = await call("/order", "PUT", { ids: [keyboard.id, mouse.id] }));
    assert.deepEqual(data.products.map((product) => product.id), [keyboard.id, mouse.id]);
    ({ data } = await call(`/products/${keyboard.id}`, "DELETE"));
    assert.equal(data.products.length, 1);
    assert.equal((await call(`/image/${keyboard.id}`)).status, 404);
    assert.equal((await call("/play", "POST", {})).status, 200);
  } finally {
    await close();
  }
});

test("a channel's gear list is only changed with that channel's key", async () => {
  const { call, close } = await serve({ stateId: "kanal", authorizeControl: (request) => request.headers["x-channel-key"] === "rigtig" });
  try {
    assert.equal((await call("/products", "POST", { name: "Mus" })).status, 401);
    assert.equal((await call("/play", "POST", {})).status, 401);
    const { status, data } = await call("/products", "POST", { name: "Mus" }, { "x-channel-key": "rigtig" });
    assert.deepEqual([status, data.products.length, data.passwordRequired], [200, 1, false]);
  } finally {
    await close();
  }
});
