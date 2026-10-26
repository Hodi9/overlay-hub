import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// ratings.js er et browser-script, der sætter window.RATINGS — kør det i en tom sandbox.
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, "ratings", "ratings.js"), "utf8"), sandbox);
const ratings = sandbox.window.RATINGS;

test("ratings-listen er en liste, og hvert spil har id og titel", () => {
  assert.ok(Array.isArray(ratings));
  for (const g of ratings) {
    assert.match(g.id, /^[a-z0-9-]+$/, `id: ${g.id}`);
    assert.ok(typeof g.title === "string" && g.title.trim(), `titel mangler på ${g.id}`);
  }
});

test("id'er er unikke", () => {
  const ids = ratings.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("score er null eller mellem 1 og 10 i halve point", () => {
  for (const g of ratings) {
    if (g.score === null) continue;
    assert.ok(typeof g.score === "number" && g.score >= 1 && g.score <= 10, `score på ${g.id}: ${g.score}`);
    assert.equal(g.score * 2, Math.round(g.score * 2), `score på ${g.id} skal være hele eller halve point`);
  }
});

test("et billede peger på en fil, der findes", () => {
  for (const g of ratings) {
    if (!g.image) continue;
    assert.ok(g.image.startsWith("/img/"), `billede på ${g.id} skal ligge under /img/`);
    assert.ok(fs.existsSync(path.join(root, g.image)), `${g.image} findes ikke`);
  }
});
