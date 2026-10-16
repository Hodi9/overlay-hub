import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createSiteGate, collapseLeadingSlashes } from "../siteGate.js";

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
      assert.equal(r.headers.get("www-authenticate"), null); // ingen browser-dialog med brugernavn
      assert.equal(r.headers.get("cache-control"), "no-store");
      const html = await r.text();
      assert.match(html, /type="password"/);
      assert.ok(!/username|brugernavn/i.test(html), "login-siden skal kun have ét felt");
      assert.ok(!html.includes("forside"));
    }
  });
});

const form = (password) => ({ method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }).toString() });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

test("login-siden: rigtig kode giver en cookie, der holder forsiden åben", async () => {
  await withApp("hemmelig-kode", async (base) => {
    const r = await fetch(base + "/", form("hemmelig-kode"));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/");
    const setCookie = r.headers.get("set-cookie") || "";
    assert.match(setCookie, /^site_auth=[0-9a-f]{64};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=2592000/);
    assert.ok(!/Secure/.test(setCookie)); // http lokalt
    assert.ok(!setCookie.includes("hemmelig-kode"));
    for (const p of ["/", "/index.html"]) {
      const ok = await fetch(base + p, { headers: { cookie: cookieOf(r) } });
      assert.equal(ok.status, 200, p);
      assert.equal(await ok.text(), "forside");
      assert.equal(ok.headers.get("cache-control"), "private, no-cache");
    }
    const https = await fetch(base + "/", { ...form("hemmelig-kode"), headers: { ...form("").headers, "x-forwarded-proto": "https" } });
    assert.match(https.headers.get("set-cookie") || "", /; Secure/);
  });
});

test("login-siden: forkert kode, forfalsket cookie og cookie fra en anden kode afvises", async () => {
  let other;
  await withApp("anden-kode", async (base) => { other = cookieOf(await fetch(base + "/", form("anden-kode"))); });
  assert.match(other, /^site_auth=/);
  await withApp("hemmelig-kode", async (base) => {
    for (const body of [form("forkert"), form(""), { method: "POST", body: "uden=kode", headers: { "content-type": "application/x-www-form-urlencoded" } },
      { method: "POST", body: "x".repeat(5000), headers: { "content-type": "application/x-www-form-urlencoded" } },
      { method: "POST", body: JSON.stringify({ password: "hemmelig-kode" }), headers: { "content-type": "application/json" } }]) {
      const r = await fetch(base + "/", { redirect: "manual", ...body });
      assert.equal(r.status, 401);
      assert.equal(r.headers.get("set-cookie"), null);
      assert.match(await r.text(), /type="password"/);
    }
    assert.match(await (await fetch(base + "/", form("forkert"))).text(), /Forkert kode/);
    for (const cookie of ["site_auth=", "site_auth=abc", "site_auth=" + "0".repeat(64), "andet=1", other, "site_auth"]) {
      assert.equal((await fetch(base + "/", { headers: { cookie } })).status, 401, cookie);
    }
    assert.equal((await fetch(base + "/", { headers: { cookie: "x=1; " + cookieOf(await fetch(base + "/", form("hemmelig-kode"))) } })).status, 200);
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

// Sender stien præcis som skrevet (fetch ville pæne den op), så vi tester det serveren faktisk ser.
function rawGet(port, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function listen(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, port: server.address().port };
}

test("forsiden kan ikke snydes med kodede, doblede eller punktum-stier", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  fs.writeFileSync(path.join(dir, "index.html"), "den-rigtige-forside");
  const app = express();
  app.use(collapseLeadingSlashes);
  app.use(createSiteGate({ password: "hemmelig-kode", failDelayMs: 0 }));
  app.use(express.static(dir));
  const { server, port } = await listen(app);
  try {
    const tricks = ["/", "///", "/index.html", "//index.html", "/%69ndex.html", "/%2e/index.html", "/./index.html",
      "/img/../index.html", "/%2Findex.html", "/%2e%2e/index.html", "/INDEX.HTML", "/index.html/", "/%"];
    for (const p of tricks) {
      const r = await rawGet(port, p);
      assert.equal(r.status, 401, p);
      assert.ok(!r.body.includes("den-rigtige-forside"), p);
    }
    for (const p of ["/", "//index.html", "/%69ndex.html", "/./index.html"]) {
      const r = await rawGet(port, p, basic("x", "hemmelig-kode"));
      assert.equal(r.status, 200, p);
      assert.equal(r.body, "den-rigtige-forside", p);
    }
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("//sti virker som /sti, så kopierede links med dobbelt skråstreg ikke giver 404", async () => {
  const app = express();
  app.use(collapseLeadingSlashes);
  app.get("/hemmelig-side", (req, res) => res.send("ok " + (req.query.x || "")));
  const { server, port } = await listen(app);
  try {
    for (const p of ["/hemmelig-side", "//hemmelig-side", "///hemmelig-side"]) {
      const r = await rawGet(port, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.body, "ok ", p);
    }
    assert.equal((await rawGet(port, "//hemmelig-side?x=1")).body, "ok 1");
    assert.equal((await rawGet(port, "/en-anden-side")).status, 404);
  } finally { server.close(); }
});
