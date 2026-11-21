import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { DEFAULT_PLAN, MAX_GOALS, addGoals, cleanPlan, completeCurrent, progress, removeGoal, reorder, resetAll, restore, undoLast, updateGoal } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// GTA IRL: steder og aktiviteter på en IRL-stream (lavet til Anker), i GTA VI-stil. Overlayet ligger på /gta-irl/ og
// panelet på /gta-irl/control.html. Med en kanal (?profile=<id>) har hver kanal sin egen liste og kanalens nøgler.
export function createGtaIrlApp(context = {}) {
  const router = express.Router();
  const controlPassword = process.env.GTAIRL_CONTROL_PASSWORD || "";
  const stateId = context.stateId || "primary";
  const isChannel = Boolean(context.authorizeControl);
  let plan = { ...DEFAULT_PLAN };
  let goals = [];
  let db = context.pool || null;
  const listeners = new Set();

  const requireAuth = (req, res, next) => {
    const ok = isChannel ? context.authorizeControl(req) : !controlPassword || safeEqual(req.headers["x-gtairl-key"] || "", controlPassword);
    if (ok) return next();
    res.status(401).json({ error: "Forkert eller manglende adgangskode." });
  };

  const ready = (async () => {
    if (!db) return;
    await db.query(`CREATE TABLE IF NOT EXISTS gtairl_state (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const { rows } = await db.query("SELECT data FROM gtairl_state WHERE id = $1", [stateId]);
    if (rows[0]) ({ plan, goals } = restore(rows[0].data));
  })().catch((error) => {
    console.error("gtairl: database unavailable; using in-memory state.", error);
    db = null;
  });
  router.ready = ready;

  const payload = () => ({ plan, goals, progress: progress(goals), passwordRequired: !isChannel && Boolean(controlPassword) });

  function commit() {
    db?.query(
      `INSERT INTO gtairl_state (id, data, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [stateId, JSON.stringify({ plan, goals })]
    ).catch((error) => console.error("gtairl: could not save state.", error));
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
  router.use(express.json({ limit: "16kb" }));

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

  // Ét mål, eller flere på én gang (én pr. linje).
  router.post("/api/goals", requireAuth, (req, res) => {
    if (goals.length >= MAX_GOALS) return res.status(400).json({ error: `Listen er fuld (${MAX_GOALS}). Fjern nogle først.` });
    const added = addGoals(goals, req.body);
    if (!added) return res.status(400).json({ error: "Skriv et sted eller en aktivitet." });
    goals = added.goals;
    res.json(commit());
  });

  router.patch("/api/goals/:id", requireAuth, (req, res) => {
    const next = updateGoal(goals, req.params.id, req.body);
    if (!next) return res.status(404).json({ error: "Målet findes ikke." });
    goals = next;
    res.json(commit());
  });

  router.delete("/api/goals/:id", requireAuth, (req, res) => {
    goals = removeGoal(goals, req.params.id);
    res.json(commit());
  });

  router.put("/api/order", requireAuth, (req, res) => {
    goals = reorder(goals, req.body?.ids);
    res.json(commit());
  });

  router.post("/api/complete", requireAuth, (_req, res) => {
    goals = completeCurrent(goals);
    res.json(commit());
  });

  router.post("/api/undo", requireAuth, (_req, res) => {
    goals = undoLast(goals);
    res.json(commit());
  });

  router.post("/api/reset", requireAuth, (_req, res) => {
    goals = resetAll(goals);
    res.json(commit());
  });

  router.post("/api/clear", requireAuth, (_req, res) => {
    goals = [];
    res.json(commit());
  });

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    console.error("gtairl:", error);
    res.status(error.status || 500).json({ error: "GTA IRL-listen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!isChannel && !controlPassword) console.log("ADVARSEL: GTAIRL_CONTROL_PASSWORD er ikke sat — GTA IRL-panelet er ubeskyttet for alle med linket.");

  return router;
}
