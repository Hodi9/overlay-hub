import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function cleanHandle(value) {
  const trimmed = String(value || "").trim().replace(/^@+/, "");
  return trimmed.slice(0, 40);
}

function cleanCastMember(input, existing) {
  const base = existing || { id: crypto.randomUUID(), visible: true };
  const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim().slice(0, 60) : base.name;
  return {
    id: base.id,
    name,
    gender: ["kvinde", "mand", "andet"].includes(input?.gender) ? input.gender : (base.gender || "andet"),
    instagram: input?.instagram !== undefined ? cleanHandle(input.instagram) : (base.instagram || ""),
    tiktok: input?.tiktok !== undefined ? cleanHandle(input.tiktok) : (base.tiktok || ""),
    photo: input?.photo !== undefined ? String(input.photo || "").trim().slice(0, 300) : (base.photo || ""),
    visible: typeof input?.visible === "boolean" ? input.visible : (base.visible !== undefined ? base.visible : true)
  };
}

const DEFAULT_CAST = [
  cleanCastMember({ name: "Iben Haastrup", gender: "kvinde", instagram: "ibenhaastrup", tiktok: "ibenhaastrup", photo: "/perfektmatch/photos/iben.jpg" }, null),
  cleanCastMember({ name: "Mads Frandsen", gender: "mand", instagram: "mads_frandsen", tiktok: "mads_frandsen", photo: "/perfektmatch/photos/mads.jpg" }, null)
];

export function createPerfektMatchApp() {
  const router = express.Router();
  const controlPassword = process.env.PERFEKTMATCH_CONTROL_PASSWORD || "";

  let show = { title: "Perfekt Match", episode: 1, host: "Aggo" };
  let cast = DEFAULT_CAST;
  let db = null;
  const listeners = new Set();

  function authorized(request) {
    if (!controlPassword) return true;
    const key = String(request.headers["x-perfektmatch-key"] || "");
    return safeEqual(key, controlPassword);
  }

  function requireAuth(request, response, next) {
    if (authorized(request)) return next();
    return response.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  async function connectDatabase() {
    if (!process.env.DATABASE_URL) return;
    const { Pool } = pg;
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });

    await db.query(`
      CREATE TABLE IF NOT EXISTS perfektmatch_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const result = await db.query("SELECT data FROM perfektmatch_state WHERE id = $1", ["primary"]);
    if (result.rows[0]?.data) {
      const saved = result.rows[0].data;
      if (saved.show) show = { ...show, ...saved.show };
      if (Array.isArray(saved.cast)) cast = saved.cast.map((c) => cleanCastMember(c, null));
    } else {
      await persist();
    }
  }

  async function persist() {
    if (!db) return;
    await db.query(
      `INSERT INTO perfektmatch_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      ["primary", JSON.stringify({ show, cast })]
    );
  }

  function payload() {
    return { show, cast, updatedAt: new Date().toISOString(), passwordRequired: Boolean(controlPassword) };
  }

  function broadcast() {
    const message = `data: ${JSON.stringify(payload())}\n\n`;
    for (const response of listeners) response.write(message);
  }

  function broadcastTrigger(castId) {
    const message = `event: trigger\ndata: ${JSON.stringify({ castId })}\n\n`;
    for (const response of listeners) response.write(message);
  }

  async function commit() {
    await persist();
    broadcast();
  }

  router.use(express.json({ limit: "32kb" }));

  router.get("/api/state", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(payload());
  });

  router.get("/api/events", (request, response) => {
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.flushHeaders();
    listeners.add(response);
    response.write(`data: ${JSON.stringify(payload())}\n\n`);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20000);
    request.on("close", () => {
      clearInterval(keepAlive);
      listeners.delete(response);
    });
  });

  router.patch("/api/show", requireAuth, async (request, response, next) => {
    try {
      const title = typeof request.body?.title === "string" && request.body.title.trim() ? request.body.title.trim().slice(0, 60) : show.title;
      const host = typeof request.body?.host === "string" ? request.body.host.trim().slice(0, 40) : show.host;
      const episode = Number.isFinite(Number(request.body?.episode)) ? Math.max(1, Math.round(Number(request.body.episode))) : show.episode;
      show = { title, host, episode };
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/cast", requireAuth, async (request, response, next) => {
    try {
      const name = String(request.body?.name || "").trim();
      if (!name) return response.status(400).json({ error: "Deltageren skal have et navn." });
      const member = cleanCastMember(request.body, { id: crypto.randomUUID(), visible: true });
      cast.push(member);
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/cast/:id", requireAuth, async (request, response, next) => {
    try {
      const index = cast.findIndex((c) => c.id === request.params.id);
      if (index === -1) return response.status(404).json({ error: "Deltageren findes ikke." });
      cast[index] = cleanCastMember(request.body, cast[index]);
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/cast/:id", requireAuth, async (request, response, next) => {
    try {
      cast = cast.filter((c) => c.id !== request.params.id);
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/cast-order", requireAuth, async (request, response, next) => {
    try {
      const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
      const byId = new Map(cast.map((c) => [c.id, c]));
      const reordered = ids.map((id) => byId.get(id)).filter(Boolean);
      for (const member of cast) if (!ids.includes(member.id)) reordered.push(member);
      cast = reordered;
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  // manual "vis nu" trigger — doesn't change persisted state, just tells every open
  // overlay to pop this cast member's social box on right now
  router.post("/api/cast/:id/trigger", requireAuth, (request, response) => {
    const member = cast.find((c) => c.id === request.params.id);
    if (!member) return response.status(404).json({ error: "Deltageren findes ikke." });
    broadcastTrigger(member.id);
    response.json({ ok: true });
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "Perfekt Match-servicen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) {
    console.log("ADVARSEL: PERFEKTMATCH_CONTROL_PASSWORD er ikke sat — perfektmatch-panelet er ubeskyttet for alle med linket.");
  }

  connectDatabase().catch((error) => {
    console.error("Perfekt Match database connection failed; using in-memory state.", error);
  });

  return router;
}
