import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createSiteGate } from "../siteGate.js";

async function withApp(password, fn) {
  const app = express();
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(createSiteGate({ password, failDelayMs: 0 }));
  app.get(["/", "/index.html"], (_req, res) => res.send("forside"));
  app.get("/tlou2/", (_req, res) => res.send("overlay"));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const basic = (user, pass) => ({ authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") });

test("uden SITE_PASSWORD er forsiden åben som før", async () => {
  await withApp("", async (base) => {
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal((await fetch(base + "/index.html")).status, 200);
  });
  await withApp(undefined, async (base) => {
    assert.equal((await fetch(base + "/")).status, 200);
  });
});

test("med SITE_PASSWORD kræver forsiden koden, uanset hvordan den nås", async () => {
  await withApp("hemmelig-kode", async (base) => {
    for (const p of ["/", "/index.html", "/INDEX.HTML", "/index.html/", "//"]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 401, p);
      assert.match(r.headers.get("www-authenticate") || "", /^Basic /);
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.equal(await r.text(), "Adgangskode påkrævet");
    }
  });
});

test("forkert kode afvises, rigtig kode slipper igennem (brugernavn ignoreres)", async () => {
  await withApp("hemmelig-kode", async (base) => {
    assert.equal((await fetch(base + "/", { headers: basic("x", "forkert") })).status, 401);
    assert.equal((await fetch(base + "/", { headers: basic("x", "") })).status, 401);
    assert.equal((await fetch(base + "/", { headers: { authorization: "Basic !!!ikke-base64!!!" } })).status, 401);
    assert.equal((await fetch(base + "/", { headers: { authorization: "Bearer hemmelig-kode" } })).status, 401);
    const ok = await fetch(base + "/", { headers: basic("hvem-som-helst", "hemmelig-kode") });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "forside");
    assert.equal((await fetch(base + "/index.html", { headers: basic("", "hemmelig-kode") })).status, 200);
  });
});

test("koder med kolon virker, og kun hele koden tæller", async () => {
  await withApp("a:b:c", async (base) => {
    assert.equal((await fetch(base + "/", { headers: basic("u", "a:b:c") })).status, 200);
    assert.equal((await fetch(base + "/", { headers: basic("u", "b:c") })).status, 401);
    assert.equal((await fetch(base + "/", { headers: basic("u", "a:b:c-og-mere") })).status, 401);
  });
});

test("overlays og /health ligger ikke bag koden (OBS kan ikke logge ind)", async () => {
  await withApp("hemmelig-kode", async (base) => {
    assert.equal((await fetch(base + "/health")).status, 200);
    assert.equal((await fetch(base + "/tlou2/")).status, 200);
  });
});
