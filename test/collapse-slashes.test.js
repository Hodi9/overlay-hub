import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { collapseLeadingSlashes } from "../collapseLeadingSlashes.js";

// Sender stien præcis som skrevet (fetch ville pæne den op), så vi tester det serveren faktisk ser.
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("//sti virker som /sti, så kopierede links med dobbelt skråstreg ikke giver 404", async () => {
  const app = express();
  app.use(collapseLeadingSlashes);
  app.get("/hemmelig-side", (req, res) => res.send("ok " + (req.query.x || "")));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;
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
