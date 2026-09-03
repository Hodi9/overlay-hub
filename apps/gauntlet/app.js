import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const defaultGames = () => [
  { id: "fortnite", name: "Fortnite", color: "#2f7fe0", icon: "F", type: "check", done: false, count: 0, deaths: 47, visible: true },
  { id: "warzone", name: "Warzone", color: "#6f7a3f", icon: "WZ", type: "check", done: false, count: 0, deaths: 34, visible: true },
  { id: "minecraft", name: "Minecraft", color: "#96622f", icon: "creeper", type: "count", done: false, count: 3, deaths: 1, visible: true },
  { id: "lol", name: "League of Legends", color: "#0aa8a0", icon: "LoL", type: "check", done: false, count: 0, deaths: 0, visible: true },
  { id: "rocketleague", name: "Rocket League", color: "#e8631f", icon: "RL", type: "check", done: false, count: 0, deaths: 0, visible: true }
];

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40) || "game";
}

function autoIcon(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return String(name || "??").slice(0, 2).toUpperCase();
}

function cleanGame(input, existing) {
  const base = existing || { id: crypto.randomUUID(), done: false, count: 0, deaths: 0 };
  const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim().slice(0, 40) : base.name;
  return {
    id: base.id,
    name,
    color: HEX_RE.test(input?.color || "") ? input.color : (base.color || "#5a6270"),
    icon: typeof input?.icon === "string" && input.icon.trim() ? input.icon.trim().slice(0, 8) : (base.icon || autoIcon(name)),
    type: input?.type === "count" ? "count" : (input?.type === "check" ? "check" : (base.type || "check")),
    done: typeof input?.done === "boolean" ? input.done : Boolean(base.done),
    count: Math.max(0, Math.round(toNumber(input?.count, base.count || 0))),
    deaths: Math.max(0, Math.round(toNumber(input?.deaths, base.deaths || 0))),
    visible: typeof input?.visible === "boolean" ? input.visible : (base.visible !== undefined ? base.visible : true)
  };
}

export function createGauntletApp() {
  const router = express.Router();
  const controlPassword = process.env.GAUNTLET_CONTROL_PASSWORD || "";

  let games = defaultGames();
  let db = null;
  const listeners = new Set();

  function authorized(request) {
    if (!controlPassword) return true;
    const key = String(request.headers["x-gauntlet-key"] || "");
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
      CREATE TABLE IF NOT EXISTS gauntlet_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const result = await db.query("SELECT data FROM gauntlet_state WHERE id = $1", ["primary"]);
    if (Array.isArray(result.rows[0]?.data)) {
      games = result.rows[0].data.map((g) => cleanGame(g, null));
    } else {
      await persist();
    }
  }

  async function persist() {
    if (!db) return;
    await db.query(
      `INSERT INTO gauntlet_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      ["primary", JSON.stringify(games)]
    );
  }

  function payload() {
    return { games, updatedAt: new Date().toISOString(), passwordRequired: Boolean(controlPassword) };
  }

  function broadcast() {
    const message = `data: ${JSON.stringify(payload())}\n\n`;
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

  router.post("/api/games", requireAuth, async (request, response, next) => {
    try {
      const name = String(request.body?.name || "").trim();
      if (!name) return response.status(400).json({ error: "Spillet skal have et navn." });
      const game = cleanGame(request.body, { id: `${slugify(name)}-${crypto.randomUUID().slice(0, 6)}`, done: false, count: 0, deaths: 0 });
      games.push(game);
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/games/:id", requireAuth, async (request, response, next) => {
    try {
      const index = games.findIndex((g) => g.id === request.params.id);
      if (index === -1) return response.status(404).json({ error: "Spillet findes ikke." });
      games[index] = cleanGame(request.body, games[index]);
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/games/:id", requireAuth, async (request, response, next) => {
    try {
      games = games.filter((g) => g.id !== request.params.id);
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/order", requireAuth, async (request, response, next) => {
    try {
      const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
      const byId = new Map(games.map((g) => [g.id, g]));
      const reordered = ids.map((id) => byId.get(id)).filter(Boolean);
      for (const game of games) if (!ids.includes(game.id)) reordered.push(game);
      games = reordered;
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "Gauntlet-servicen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) {
    console.log("ADVARSEL: GAUNTLET_CONTROL_PASSWORD er ikke sat — gauntlet-panelet er ubeskyttet for alle med linket.");
  }

  connectDatabase().catch((error) => {
    console.error("Gauntlet database connection failed; using in-memory state.", error);
  });

  return router;
}
