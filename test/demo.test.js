import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

delete process.env.DATABASE_URL;
for (const key of ["TLOU2", "GTA5", "RDR2", "CYBERPUNK", "MAFIA1"]) {
  delete process.env[`${key}_CONTROL_PASSWORD`];
  delete process.env[`${key}_TRACKER_KEY`];
}

const { demoStep, demoCompleted, demoFraction } = await import("../apps/_lib/demo.js");
const { createTlou2App } = await import("../apps/tlou2/app.js");
const { createCyberpunkApp } = await import("../apps/cyberpunk/app.js");
const { createMafia1App } = await import("../apps/mafia1/app.js");
const { createGta5App } = await import("../apps/gta5/app.js");
const { createRdr2App } = await import("../apps/rdr2/app.js");

const TRACKERS = [
  { name: "TLOU2", mount: "/tlou2", create: createTlou2App },
  { name: "Cyberpunk", mount: "/cyberpunk", create: createCyberpunkApp },
  { name: "Mafia I", mount: "/mafia1", create: createMafia1App },
  { name: "GTA V", mount: "/gta5", create: createGta5App },
  { name: "RDR2", mount: "/rdr2", create: createRdr2App }
];

async function withServer(tracker, fn) {
  const app = express();
  app.use(tracker.mount, tracker.create());
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}${tracker.mount}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const getState = (base, query) => fetch(`${base}/api/state?${query}`).then((r) => r.json());

test("demoStep lander et sted mellem start og slut, aldrig på 0 og aldrig helt færdigt", () => {
  for (const total of [3, 10, 25, 120]) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const step = demoStep(total, fraction);
      assert.ok(step >= 1 && step <= total - 1, `total ${total}, fraction ${fraction} gav ${step}`);
    }
  }
  assert.equal(demoStep(0, 0.5), 0);
  assert.equal(demoStep(1, 0.5), 0);
});

test("demoFraction kræver et tal og holder sig mellem 0 og 1", () => {
  assert.equal(demoFraction({ query: {} }), null);
  assert.equal(demoFraction({ query: { demo: "" } }), null);
  assert.equal(demoFraction({ query: { demo: "abc" } }), null);
  assert.equal(demoFraction({ query: { demo: "0.4" } }), 0.4);
  assert.ok(demoFraction({ query: { demo: "1" } }) < 1);
  assert.equal(demoFraction({ query: { demo: "-3" } }), 0);
});

test("demoCompleted springer valgfrie missioner over og klarer aldrig alle", () => {
  const chapters = [{}, { optional: true }, {}, {}, { optional: true }, {}, {}, {}, {}, {}, {}, {}];
  const { completed, lastCompletedIndex } = demoCompleted(chapters, 0.5, (c) => !c.optional);
  assert.ok(completed.size >= 1 && completed.size < 10);
  for (const index of completed) assert.ok(!chapters[index].optional);
  assert.equal(lastCompletedIndex, Math.max(...completed));
});

for (const tracker of TRACKERS) {
  test(`${tracker.name}: ?demo viser et gennemført trin uden at gemme noget`, async () => {
    await withServer(tracker, async (base) => {
      const before = await getState(base, "profile=demotest");
      assert.equal(before.percent, 0, "en ny tracker starter på 0 %");

      const demo = await getState(base, "profile=demotest&demo=0.5");
      assert.ok(demo.percent > 0 && demo.percent < 100, `demo-procent ${demo.percent}`);
      assert.ok(demo.progress.completed > 0 && !demo.finished);

      const after = await getState(base, "profile=demotest");
      assert.equal(after.percent, 0, "demoen må ikke ændre den gemte fremgang");
    });
  });

  test(`${tracker.name}: demo-events starter med et gennemført trin`, async () => {
    await withServer(tracker, async (base) => {
      const controller = new AbortController();
      const response = await fetch(`${base}/api/events?profile=demotest2&demo=0.5`, { signal: controller.signal });
      const reader = response.body.getReader();
      const { value } = await reader.read();
      controller.abort();
      const text = new TextDecoder().decode(value);
      const payload = JSON.parse(text.replace(/^data: /, "").trim());
      assert.ok(payload.progress.completed > 0 && !payload.finished);
    });
  });
}

test("er der rigtig fremgang, vises den og ikke en demo", async () => {
  await withServer(TRACKERS[0], async (base) => {
    await fetch(`${base}/api/current?profile=demotest3`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: 3 })
    });
    const real = await getState(base, "profile=demotest3");
    const withDemo = await getState(base, "profile=demotest3&demo=0.9");
    assert.equal(real.progress.completed, 3);
    assert.equal(withDemo.progress.completed, 3);
  });
});
