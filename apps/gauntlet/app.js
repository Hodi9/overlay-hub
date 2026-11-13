import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const defaultGames = () => [
  { id: "fortnite", name: "Fortnite", color: "#2f7fe0", icon: "F", done: false, count: 0, deaths: 0, visible: true },
  { id: "rocketleague", name: "Rocket League", color: "#e8631f", icon: "RL", done: false, count: 0, deaths: 0, visible: true },
  { id: "warzone", name: "Warzone", color: "#6f7a3f", icon: "WZ", done: false, count: 0, deaths: 0, visible: true },
  { id: "fallguys", name: "Fall Guys", color: "#ee3f96", icon: "FG", done: false, count: 0, deaths: 0, visible: true },
  { id: "cswingman", name: "CS Wingman", color: "#4d6f9c", icon: "CS", done: false, count: 0, deaths: 0, visible: true },
  { id: "apex", name: "Apex Legends", color: "#c4302b", icon: "AL", done: false, count: 0, deaths: 0, visible: true },
  { id: "lol", name: "League of Legends", color: "#0aa8a0", icon: "LoL", done: false, count: 0, deaths: 0, visible: true }
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
    done: typeof input?.done === "boolean" ? input.done : Boolean(base.done),
    count: Math.max(0, Math.round(toNumber(input?.count, base.count || 0))),
    deaths: Math.max(0, Math.round(toNumber(input?.deaths, base.deaths || 0))),
    visible: typeof input?.visible === "boolean" ? input.visible : (base.visible !== undefined ? base.visible : true)
  };
}

function cleanRun(input, existing) {
  return {
    resets: Math.min(9999, Math.max(0, Math.round(toNumber(input?.resets, existing.resets)))),
    showResets: typeof input?.showResets === "boolean" ? input.showResets : existing.showResets,
    current: typeof input?.current === "string" ? input.current.slice(0, 80) : existing.current || "",
    cover: typeof input?.cover === "boolean" ? input.cover : Boolean(existing.cover)
  };
}

export function createGauntletApp(context = {}) {
  const router = express.Router();
  const controlPassword = process.env.GAUNTLET_CONTROL_PASSWORD || "";
  const stateId = context.stateId || "primary";
  const isChannel = Boolean(context.authorizeControl);

  let games = defaultGames();
  // How many times the run has been reset (a lost game sends everyone back to the start), whether the
  // overlay shows that number, and which game is being played now (its id; the overlay puts a frame around it).
  // "cover" hides everything on both overlays; the main one shows only the line "Får jeg løn?" instead.
  let run = { resets: 0, showResets: true, current: "", cover: false };

  // The games are played in order and a loss sends the run back to the first one, so the game being played now
  // is the first one that is not completed. One picked in the panel goes first, while it is shown and not completed.
  const playable = (g) => !g.done && g.visible !== false;
  const currentId = () => (games.find((g) => g.id === run.current && playable(g)) || games.find(playable) || { id: "" }).id;
  // The next game to play after the one at "from": the first one further down that is not completed, else the first one above.
  function nextAfter(from) {
    const at = games.findIndex((g) => g.id === from);
    return ([...games.slice(at + 1), ...games.slice(0, Math.max(at, 0))].find(playable) || { id: "" }).id;
  }
  const runId = `${stateId}:run`;
  let db = null;
  const listeners = new Set();

  function authorized(request) {
    if (isChannel) return context.authorizeControl(request);
    if (!controlPassword) return true;
    const key = String(request.headers["x-gauntlet-key"] || "");
    return safeEqual(key, controlPassword);
  }

  function requireAuth(request, response, next) {
    if (authorized(request)) return next();
    return response.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  async function connectDatabase() {
    if (!context.pool && !process.env.DATABASE_URL) return;
    const { Pool } = pg;
    db = context.pool || new Pool({
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

    const result = await db.query("SELECT data FROM gauntlet_state WHERE id = $1", [stateId]);
    if (Array.isArray(result.rows[0]?.data)) {
      games = result.rows[0].data.map((g) => cleanGame(g, null));
    } else {
      await persist();
    }

    const savedRun = await db.query("SELECT data FROM gauntlet_state WHERE id = $1", [runId]);
    if (savedRun.rows[0]) run = cleanRun(savedRun.rows[0].data, run);

    if (!isChannel) await applyListUpdate();
  }

  // One-time update of the primary list (Nov 2026): add the games that are missing and put the
  // list in the agreed order. Existing games keep their progress; games that are not on the new
  // list (Minecraft) are kept, last. A marker row makes sure it never runs twice, so games the
  // owner later removes in the control panel stay removed.
  async function applyListUpdate() {
    const markerId = `${stateId}:list-2026-11`;
    const marker = await db.query("SELECT 1 FROM gauntlet_state WHERE id = $1", [markerId]);
    if (marker.rows.length) return;

    const byName = new Map(games.map((g) => [g.name.toLowerCase(), g]));
    const wanted = defaultGames().map((d) => byName.get(d.name.toLowerCase())
      || cleanGame(d, { id: `${slugify(d.name)}-${crypto.randomUUID().slice(0, 6)}`, done: false, count: 0, deaths: 0 }));
    games = [...wanted, ...games.filter((g) => !wanted.includes(g))];
    await persist();
    await db.query(
      `INSERT INTO gauntlet_state (id, data) VALUES ($1, '{"applied":true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [markerId]
    );
  }

  async function persist() {
    if (!db) return;
    await db.query(
      `INSERT INTO gauntlet_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [stateId, JSON.stringify(games)]
    );
    await db.query(
      `INSERT INTO gauntlet_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [runId, JSON.stringify(run)]
    );
  }

  function payload() {
    return { games, resets: run.resets, showResets: run.showResets, current: currentId(), cover: run.cover, updatedAt: new Date().toISOString(), passwordRequired: isChannel || Boolean(controlPassword) };
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
      const wasCurrent = currentId() === games[index].id;
      games[index] = cleanGame(request.body, games[index]);
      // Completing the game being played moves the frame on to the next one.
      if (wasCurrent && !playable(games[index])) run = { ...run, current: nextAfter(games[index].id) };
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

  // A lost game: the run starts over. One more reset on the counter, every check mark is taken off, and the
  // first game is the one being played again.
  // Deaths are kept; they count for the whole event.
  router.post("/api/reset", requireAuth, async (_request, response, next) => {
    try {
      games = games.map((g) => ({ ...g, done: false, count: 0 }));
      run = { ...run, resets: run.resets + 1, current: (games.find(playable) || { id: "" }).id };
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  // Correct the reset counter by hand, show/hide it on the overlay, or cover the whole overlay.
  router.patch("/api/run", requireAuth, async (request, response, next) => {
    try {
      run = cleanRun(request.body, run);
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

  if (!isChannel && !controlPassword) {
    console.log("ADVARSEL: GAUNTLET_CONTROL_PASSWORD er ikke sat — gauntlet-panelet er ubeskyttet for alle med linket.");
  }

  router.ready = connectDatabase().catch((error) => {
    console.error("Gauntlet database connection failed; using in-memory state.", error);
  });

  return router;
}
