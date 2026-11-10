import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  DEFAULT_PLAN, MAX_ENTRANTS, addEntrant, buildBracket, champion, cleanPlan, liveMatch,
  removeEntrant, reorder, restore, setResult, shuffle, updateEntrant
} from "./state.js";
import { imageFromDataUrl, packImages, sendImage, unpackImages } from "../_lib/images.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Turneringsoverlay: en knockout-turnering for hold eller enkeltspillere. /turnering/ viser hele bracketen,
// /turnering/?view=match viser kun den kamp, der spilles nu, og panelet ligger på /turnering/control.html.
// With a channel context (?profile=<id>) the app keeps one tournament per channel and checks that channel's keys.
export function createTurneringApp(context = {}) {
  const router = express.Router();
  const controlPassword = process.env.TURNERING_CONTROL_PASSWORD || "";
  const stateId = context.stateId || "primary";
  const isChannel = Boolean(context.authorizeControl);
  let plan = { ...DEFAULT_PLAN };
  let entrants = [];
  let results = {};
  let logos = new Map(); // entrant id -> picture
  let db = context.pool || null;
  const listeners = new Set();

  const requireAuth = (req, res, next) => {
    const ok = isChannel ? context.authorizeControl(req) : !controlPassword || safeEqual(req.headers["x-turnering-key"] || "", controlPassword);
    if (ok) return next();
    res.status(401).json({ error: "Forkert eller manglende adgangskode." });
  };

  const ready = (async () => {
    if (!db) return;
    await db.query(`CREATE TABLE IF NOT EXISTS turnering_state (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const { rows } = await db.query("SELECT data FROM turnering_state WHERE id = $1", [stateId]);
    if (!rows[0]) return;
    ({ plan, entrants, results } = restore(rows[0].data));
    logos = unpackImages(rows[0].data?.logos);
  })().catch((error) => {
    console.error("turnering: database unavailable; using in-memory state.", error);
    db = null;
  });
  router.ready = ready;

  // The overlay and the panel get the finished bracket, so neither has to work it out again.
  function payload() {
    const rounds = buildBracket(entrants, results);
    return {
      plan, entrants, rounds,
      live: liveMatch(rounds, plan.live),
      champion: champion(rounds),
      started: Object.keys(results).length > 0,
      passwordRequired: !isChannel && Boolean(controlPassword)
    };
  }

  function commit() {
    db?.query(
      `INSERT INTO turnering_state (id, data, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [stateId, JSON.stringify({ plan, entrants, results, logos: packImages(logos) })]
    ).catch((error) => console.error("turnering: could not save state.", error));
    const message = `data: ${JSON.stringify(payload())}\n\n`;
    for (const response of listeners) response.write(message);
    return payload();
  }

  // Who meets whom follows from the order of the entrants, so the list is locked once a match has a result.
  const requireOpenDraw = (_req, res, next) => {
    if (!Object.keys(results).length) return next();
    res.status(409).json({ error: "Turneringen er i gang. Nulstil resultaterne, før du ændrer deltagerne eller rækkefølgen." });
  };

  router.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (req.path.startsWith("/api/") && !req.path.startsWith("/api/logo/")) res.setHeader("Cache-Control", "no-store");
    // Ingen læsning eller ændring, før gemt tilstand er hentet — ellers kunne en tidlig ændring blive overskrevet.
    ready.then(() => next(), next);
  });
  router.use(express.json({ limit: "700kb" }));

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

  router.get("/api/logo/:id", (req, res) => sendImage(logos, req.params.id, res));

  // Panelet bruger den til at tjekke koden, før den gemmes.
  router.post("/api/login", requireAuth, (_req, res) => res.json({ ok: true }));

  router.patch("/api/plan", requireAuth, (req, res) => {
    plan = cleanPlan(req.body, plan);
    res.json(commit());
  });

  router.post("/api/entrants", requireAuth, requireOpenDraw, (req, res) => {
    if (entrants.length >= MAX_ENTRANTS) return res.status(400).json({ error: `Der er plads til ${MAX_ENTRANTS} deltagere.` });
    const added = addEntrant(entrants, req.body);
    if (!added) return res.status(400).json({ error: "Skriv et navn." });
    entrants = added.entrants;
    res.json(commit());
  });

  // Navn og linjen under kan rettes midt i turneringen; det flytter ikke på nogen kampe.
  router.patch("/api/entrants/:id", requireAuth, (req, res) => {
    const next = updateEntrant(entrants, req.params.id, req.body);
    if (!next) return res.status(404).json({ error: "Deltageren findes ikke." });
    entrants = next;
    res.json(commit());
  });

  router.put("/api/entrants/:id/logo", requireAuth, (req, res) => {
    const id = req.params.id;
    if (!entrants.some((entrant) => entrant.id === id)) return res.status(404).json({ error: "Deltageren findes ikke." });
    const image = req.body?.dataUrl ? imageFromDataUrl(req.body.dataUrl) : null;
    if (req.body?.dataUrl && !image) return res.status(400).json({ error: "Billedet kunne ikke bruges. Vælg en PNG, JPG eller WebP." });
    if (image) logos.set(id, image); else logos.delete(id);
    entrants = entrants.map((entrant) => (entrant.id === id ? { ...entrant, logo: image ? image.version : "" } : entrant));
    res.json(commit());
  });

  router.delete("/api/entrants/:id", requireAuth, requireOpenDraw, (req, res) => {
    entrants = removeEntrant(entrants, req.params.id);
    logos.delete(req.params.id);
    res.json(commit());
  });

  router.put("/api/order", requireAuth, requireOpenDraw, (req, res) => {
    entrants = reorder(entrants, req.body?.ids);
    res.json(commit());
  });

  router.post("/api/shuffle", requireAuth, requireOpenDraw, (_req, res) => {
    entrants = shuffle(entrants);
    res.json(commit());
  });

  // Stillingen i en kamp, og hvem der vandt (se setResult).
  router.patch("/api/matches/:id", requireAuth, (req, res) => {
    const next = setResult(entrants, results, req.params.id, req.body, plan.bestOf);
    if (!next) return res.status(400).json({ error: "Den kamp har ikke to deltagere endnu." });
    results = next;
    res.json(commit());
  });

  // Alle resultater væk; deltagerne bliver stående.
  router.post("/api/reset", requireAuth, (_req, res) => {
    results = {};
    plan = { ...plan, live: "" };
    res.json(commit());
  });

  // Helt forfra: også deltagerne væk.
  router.post("/api/clear", requireAuth, (_req, res) => {
    results = {};
    entrants = [];
    logos = new Map();
    plan = { ...plan, live: "" };
    res.json(commit());
  });

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Billedet er for stort." });
    console.error("turnering:", error);
    res.status(error.status || 500).json({ error: "Turneringen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!isChannel && !controlPassword) console.log("ADVARSEL: TURNERING_CONTROL_PASSWORD er ikke sat — turnerings-panelet er ubeskyttet for alle med linket.");

  return router;
}
