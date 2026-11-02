import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { DEFAULT_PLAN, MAX_GUESTS, addGuest, cleanPlan, everyoneOut, removeGuest, reorder, restore, updateGuest } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Gæsteoverlay til en stream: hvem er i studiet lige nu, med navn og titel. Overlayet ligger på /gaester/ og panelet på
// /gaester/control.html. Ikke på forsiden.
export function createGaesterApp({ pool = null } = {}) {
  const router = express.Router();
  const controlPassword = process.env.GAESTER_CONTROL_PASSWORD || "";
  let plan = { ...DEFAULT_PLAN };
  let guests = [];
  let db = pool;
  const listeners = new Set();

  const requireAuth = (req, res, next) => {
    if (!controlPassword || safeEqual(req.headers["x-gaester-key"] || "", controlPassword)) return next();
    res.status(401).json({ error: "Forkert eller manglende adgangskode." });
  };

  const ready = (async () => {
    if (!db) return;
    await db.query(`CREATE TABLE IF NOT EXISTS gaester_state (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const { rows } = await db.query("SELECT data FROM gaester_state WHERE id = 'primary'");
    if (rows[0]) ({ plan, guests } = restore(rows[0].data));
  })().catch((error) => {
    console.error("gaester: database unavailable; using in-memory state.", error);
    db = null;
  });

  const payload = () => ({ plan, guests, passwordRequired: Boolean(controlPassword) });

  function commit() {
    db?.query(
      `INSERT INTO gaester_state (id, data, updated_at) VALUES ('primary', $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify({ plan, guests })]
    ).catch((error) => console.error("gaester: could not save state.", error));
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

  router.post("/api/guests", requireAuth, (req, res) => {
    if (guests.length >= MAX_GUESTS) return res.status(400).json({ error: `Listen er fuld (${MAX_GUESTS}). Fjern nogen først.` });
    const added = addGuest(guests, req.body);
    if (!added) return res.status(400).json({ error: "Skriv et navn." });
    guests = added.guests;
    res.json(commit());
  });

  router.patch("/api/guests/:id", requireAuth, (req, res) => {
    const next = updateGuest(guests, req.params.id, req.body);
    if (!next) return res.status(404).json({ error: "Gæsten findes ikke." });
    guests = next;
    res.json(commit());
  });

  router.delete("/api/guests/:id", requireAuth, (req, res) => {
    guests = removeGuest(guests, req.params.id);
    res.json(commit());
  });

  router.put("/api/order", requireAuth, (req, res) => {
    guests = reorder(guests, req.body?.ids);
    res.json(commit());
  });

  // Alle ud af studiet på én gang (gæsterne bliver stående på listen).
  router.post("/api/everyone-out", requireAuth, (_req, res) => {
    guests = everyoneOut(guests);
    res.json(commit());
  });

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    console.error("gaester:", error);
    res.status(error.status || 500).json({ error: "Gæstelisten kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) console.log("ADVARSEL: GAESTER_CONTROL_PASSWORD er ikke sat — gæste-panelet er ubeskyttet for alle med linket.");

  return router;
}
