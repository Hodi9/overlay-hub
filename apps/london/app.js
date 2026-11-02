import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { DEFAULT_PLAN, MAX_ITEMS, addItem, advance, cleanPlan, defaultItems, moveNext, removeItem, reorder, resetStatuses, restore, updateItem } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// "Aggo & Lucas i London": en liste over, hvad de skal lave, som kan ændres undervejs i streamen.
// Ikke på forsiden; overlayet ligger på /london/ og panelet på /london/control.html.
export function createLondonApp({ pool = null } = {}) {
  const router = express.Router();
  const controlPassword = process.env.LONDON_CONTROL_PASSWORD || "";
  let plan = { ...DEFAULT_PLAN };
  let items = defaultItems();
  let db = pool;
  const listeners = new Set();

  const requireAuth = (req, res, next) => {
    if (!controlPassword || safeEqual(req.headers["x-london-key"] || "", controlPassword)) return next();
    res.status(401).json({ error: "Forkert eller manglende adgangskode." });
  };

  const ready = (async () => {
    if (!db) return;
    await db.query(`CREATE TABLE IF NOT EXISTS london_state (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const { rows } = await db.query("SELECT data FROM london_state WHERE id = 'primary'");
    if (rows[0]) ({ plan, items } = restore(rows[0].data));
  })().catch((error) => {
    console.error("london: database unavailable; using in-memory state.", error);
    db = null;
  });

  const payload = () => ({ plan, items, passwordRequired: Boolean(controlPassword) });

  function commit() {
    db?.query(
      `INSERT INTO london_state (id, data, updated_at) VALUES ('primary', $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify({ plan, items })]
    ).catch((error) => console.error("london: could not save state.", error));
    const message = `data: ${JSON.stringify(payload())}\n\n`;
    for (const response of listeners) response.write(message);
    return payload();
  }

  router.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    // Ingen læsning eller ændring, før gemt tilstand er hentet — ellers kunne en tidlig ændring blive overskrevet.
    ready.then(() => next(), next);
  });
  router.use(express.json({ limit: "8kb" }));

  router.get("/api/state", (_req, res) => res.json(payload()));

  router.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.flushHeaders();
    listeners.add(res);
    res.write(`data: ${JSON.stringify(payload())}\n\n`);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20000);
    req.on("close", () => {
      clearInterval(keepAlive);
      listeners.delete(res);
    });
  });

  // Panelet bruger den til at tjekke koden, før den gemmes.
  router.post("/api/login", requireAuth, (_req, res) => res.json({ ok: true }));

  router.patch("/api/plan", requireAuth, (req, res) => {
    plan = cleanPlan(req.body, plan);
    res.json(commit());
  });

  router.post("/api/items", requireAuth, (req, res) => {
    if (items.length >= MAX_ITEMS) return res.status(400).json({ error: `Listen er fuld (${MAX_ITEMS}). Fjern noget først.` });
    const added = addItem(items, req.body, req.body?.position === "next" ? "next" : "end");
    if (!added) return res.status(400).json({ error: "Skriv, hvad de skal lave." });
    items = added.items;
    res.json(commit());
  });

  router.patch("/api/items/:id", requireAuth, (req, res) => {
    const next = updateItem(items, req.params.id, req.body);
    if (!next) return res.status(404).json({ error: "Det punkt findes ikke." });
    items = next;
    res.json(commit());
  });

  router.delete("/api/items/:id", requireAuth, (req, res) => {
    items = removeItem(items, req.params.id);
    res.json(commit());
  });

  router.post("/api/items/:id/next", requireAuth, (req, res) => {
    if (!items.some((item) => item.id === req.params.id)) return res.status(404).json({ error: "Det punkt findes ikke." });
    items = moveNext(items, req.params.id);
    res.json(commit());
  });

  router.put("/api/order", requireAuth, (req, res) => {
    items = reorder(items, req.body?.ids);
    res.json(commit());
  });

  router.post("/api/advance", requireAuth, (_req, res) => {
    items = advance(items);
    res.json(commit());
  });

  router.post("/api/reset", requireAuth, (_req, res) => {
    items = resetStatuses(items);
    res.json(commit());
  });

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    console.error("london:", error);
    res.status(error.status || 500).json({ error: "London-planen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) console.log("ADVARSEL: LONDON_CONTROL_PASSWORD er ikke sat — london-panelet er ubeskyttet for alle med linket.");

  return router;
}
