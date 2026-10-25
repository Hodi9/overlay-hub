const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const DEFAULT_DYSTER = ["Dart", "Bowling", "Minigolf", "Brætspil", "Bordfodbold", "Wildcard"];

function defaultDuel() {
  return { points: { left: 0, right: 0 }, sets: { left: 0, right: 0 } };
}

function defaultPlayers() {
  return {
    left: { name: "Hold 1", image: "", color: "#123f6e" },
    right: { name: "Hold 2", image: "", color: "#d6d6d6" },
  };
}

const MAX_IMAGE_LENGTH = 900000;

// The address of the browser behind a socket. Render's proxy appends the real address as the last
// x-forwarded-for entry; earlier entries come from the client and cannot be trusted.
function clientIp(socket) {
  const forwarded = String(socket?.handshake?.headers?.["x-forwarded-for"] || "").split(",").map((part) => part.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : socket?.handshake?.address || "unknown";
}

function cleanColor(value, fallback) {
  const v = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

function cleanImage(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.length > MAX_IMAGE_LENGTH) return null;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) return v;
  if (/^https:\/\/[^\s"'<>]+$/.test(v) || /^\/brosvsbros\/images\/[\w.-]+$/.test(v)) return v;
  return null;
}

/**
 * The main overlay (no arguments, or { channels, pool } so channels get a namespace of their own), or
 * one channel's copy of it: { channelId, pool, emit, authorizeToken } as built by attachChannelNamespaces.
 */
function createBrosvsbrosApp(context = {}) {
  const router = express.Router();
  const isChannel = Boolean(context.authorizeToken);
  const PANEL_KEY = process.env.BROSVSBROS_PANEL_KEY || process.env.BROVSBRO_PANEL_KEY || "";
  const STATE_FILE = path.join(process.env.DATA_DIR || __dirname, "brosvsbros-state.json");

  function freshState() {
    return {
      scores: { left: 0, right: 0 },
      round: 1,
      current: null,
      queue: DEFAULT_DYSTER.map((name) => ({ id: crypto.randomUUID(), name })),
      log: [],
      duel: defaultDuel(),
      players: defaultPlayers(),
    };
  }

  function loadState() {
    try {
      const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (!loaded.duel) loaded.duel = defaultDuel();
      if (!loaded.players) loaded.players = defaultPlayers();
      return loaded;
    } catch {
      return freshState();
    }
  }

  let state = isChannel ? freshState() : loadState();
  let io = null;

  // A channel keeps its state in the database when there is one; the main overlay keeps its file.
  async function loadChannelState() {
    if (!context.pool) return;
    await context.pool.query(`
      CREATE TABLE IF NOT EXISTS brosvsbros_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await context.pool.query("SELECT data FROM brosvsbros_state WHERE id = $1", [context.channelId]);
    const loaded = result.rows[0]?.data;
    if (loaded && loaded.scores) {
      if (!loaded.duel) loaded.duel = defaultDuel();
      if (!loaded.players) loaded.players = defaultPlayers();
      state = loaded;
    }
  }
  const ready = isChannel
    ? loadChannelState().catch((error) => console.error("brosvsbros: could not load channel state; starting fresh.", error))
    : Promise.resolve();

  function saveState() {
    if (isChannel) {
      if (!context.pool) return;
      context.pool
        .query(
          `INSERT INTO brosvsbros_state (id, data, updated_at) VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [context.channelId, JSON.stringify(state)]
        )
        .catch((error) => console.error("brosvsbros: could not save channel state.", error));
      return;
    }
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {});
  }

  function playerName(p) {
    return state.players?.[p]?.name || (p === "left" ? "Hold 1" : "Hold 2");
  }

  function pushLog(entry) {
    state.log.unshift({ id: crypto.randomUUID(), at: Date.now(), entry });
    state.log = state.log.slice(0, 30);
  }

  function broadcast() {
    if (isChannel) context.emit("state", state);
    else if (io) io.emit("state", state);
    saveState();
  }

  // A link to a channel that does not exist must not show the main overlay's page.
  if (context.channels) {
    router.use((req, res, next) => {
      const profile = req.query.profile;
      if (typeof profile === "string" && profile && !context.channels.has(profile)) return res.status(404).type("text").send("Ukendt kanal");
      next();
    });
  }

  router.use(
    express.static(path.join(__dirname, "public"), {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      },
    })
  );

  router.get("/overlay", (req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "overlay.html"));
  });

  router.get("/panel", (req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "panel.html"));
  });

  // ?profile=<channel> must survive the redirects.
  const queryOf = (req) => (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");

  router.get("/duel", (req, res) => {
    const query = new URLSearchParams(queryOf(req));
    query.set("view", "duel");
    res.redirect(301, "/brosvsbros/overlay?" + query.toString());
  });

  router.get("/", (req, res) => {
    res.redirect("/brosvsbros/overlay" + queryOf(req));
  });

  function authorized(token, socket) {
    if (isChannel) return context.authorizeToken(token, socket);
    if (!PANEL_KEY) return true;
    return token === PANEL_KEY;
  }

  // One browser (overlay or panel) connecting: it gets the state and the panel's actions are handled.
  // Used for the main overlay's socket and for every channel's namespace.
  function onConnection(socket) {
    socket.emit("state", state);
    socket.emit("config", { dysterPreset: DEFAULT_DYSTER, requiresKey: isChannel || Boolean(PANEL_KEY) });

    socket.on("panel:action", (message) => {
      // Anything can arrive here from a browser; only an object is an action.
      const payload = message && typeof message === "object" ? message : {};
      const { type, token } = payload;
      if (!authorized(token, socket)) {
        socket.emit("panel:denied");
        return;
      }

      switch (type) {
        case "ping": {
          socket.emit("panel:ok");
          return;
        }
        case "score:inc": {
          const p = payload.player;
          if (p === "left" || p === "right") {
            state.scores[p] = Math.max(0, state.scores[p] + 1);
            pushLog(`${playerName(p)} +1 point`);
          }
          break;
        }
        case "score:dec": {
          const p = payload.player;
          if (p === "left" || p === "right") {
            state.scores[p] = Math.max(0, state.scores[p] - 1);
            pushLog(`${playerName(p)} -1 point`);
          }
          break;
        }
        case "player:update": {
          const p = payload.player;
          if (p !== "left" && p !== "right") return;
          const current = state.players[p] || defaultPlayers()[p];
          const next = { ...current };
          if (payload.name !== undefined) {
            const name = String(payload.name || "").trim().slice(0, 32);
            if (name) next.name = name;
          }
          if (payload.color !== undefined) next.color = cleanColor(payload.color, current.color);
          if (payload.image !== undefined) {
            const image = cleanImage(payload.image);
            if (image === null) {
              socket.emit("panel:error", "Billedet er for stort eller har et ukendt format.");
              return;
            }
            next.image = image;
          }
          state.players[p] = next;
          pushLog(`Hold opdateret: ${next.name}`);
          break;
        }
        case "players:reset": {
          state.players = defaultPlayers();
          pushLog("Hold nulstillet til standard");
          break;
        }
        case "round:set": {
          const n = Number(payload.value);
          if (Number.isFinite(n) && n > 0) state.round = Math.floor(n);
          break;
        }
        case "corner:set": {
          if (payload.corner === "left" || payload.corner === "right") {
            state.current = { name: state.current?.name || null, corner: payload.corner };
          }
          break;
        }
        case "queue:add": {
          const name = String(payload.name || "").trim();
          if (name) state.queue.push({ id: crypto.randomUUID(), name });
          break;
        }
        case "queue:remove": {
          state.queue = state.queue.filter((d) => d.id !== payload.id);
          break;
        }
        case "queue:reorder": {
          if (Array.isArray(payload.order)) {
            const byId = new Map(state.queue.map((d) => [d.id, d]));
            state.queue = payload.order.map((id) => byId.get(id)).filter(Boolean);
          }
          break;
        }
        case "dyst:next": {
          const next = state.queue.shift();
          if (next) {
            if (state.current?.name) state.queue.push({ id: crypto.randomUUID(), name: state.current.name });
            state.current = { name: next.name, corner: state.current?.corner || "left" };
            state.round += 1;
            pushLog(`Ny dyst: ${next.name}`);
          }
          break;
        }
        case "dyst:setCurrent": {
          const name = String(payload.name || "").trim();
          if (name) {
            state.current = { name, corner: state.current?.corner || "left" };
            pushLog(`Dyst sat til: ${name}`);
          }
          break;
        }
        case "dyst:clear": {
          state.current = null;
          pushLog("Dyst ryddet");
          break;
        }
        case "reset:scores": {
          state.scores = { left: 0, right: 0 };
          pushLog("Scores nulstillet");
          break;
        }
        case "duel:point:inc": {
          const p = payload.player;
          if (p === "left" || p === "right") {
            state.duel.points[p] = Math.min(11, state.duel.points[p] + 1);
          }
          break;
        }
        case "duel:point:dec": {
          const p = payload.player;
          if (p === "left" || p === "right") {
            state.duel.points[p] = Math.max(0, state.duel.points[p] - 1);
          }
          break;
        }
        case "duel:set:inc": {
          const p = payload.player;
          if (p === "left" || p === "right") {
            state.duel.sets[p] += 1;
            pushLog(`${playerName(p)} vandt sæt ${state.duel.sets[p]}`);
          }
          break;
        }
        case "duel:set:dec": {
          const p = payload.player;
          if (p === "left" || p === "right") {
            state.duel.sets[p] = Math.max(0, state.duel.sets[p] - 1);
          }
          break;
        }
        case "duel:points:reset": {
          state.duel.points = { left: 0, right: 0 };
          pushLog("Duel-point nulstillet (nyt sæt)");
          break;
        }
        case "reset:all": {
          state = {
            scores: { left: 0, right: 0 },
            round: 1,
            current: null,
            queue: DEFAULT_DYSTER.map((name) => ({ id: crypto.randomUUID(), name })),
            log: [],
            duel: defaultDuel(),
            players: state.players || defaultPlayers(),
          };
          pushLog("Alt nulstillet");
          break;
        }
        default:
          return;
      }

      broadcast();
    });
  }

  function attachSocket(server) {
    io = new Server(server, { path: "/brosvsbros/socket.io", cors: { origin: "*" }, maxHttpBufferSize: 2e6, destroyUpgrade: false });
    io.on("connection", onConnection);
    if (context.channels) attachChannelNamespaces();

    if (!isChannel && !PANEL_KEY) {
      console.log("ADVARSEL: BROSVSBROS_PANEL_KEY/BROVSBRO_PANEL_KEY er ikke sat — Bros vs Bros-panelet er ubeskyttet for alle med linket.");
    }
  }

  // Every channel gets a namespace of its own (/c/<id>) with its own copy of this app, so scores never mix.
  function attachChannelNamespaces() {
    const rooms = new Map();
    const parent = io.of(/^\/c\/[a-z2-7]{12}$/);
    parent.use((socket, next) => (context.channels.has(socket.nsp.name.slice(3)) ? next() : next(new Error("Ukendt kanal"))));
    parent.on("connection", async (socket) => {
      const id = socket.nsp.name.slice(3);
      let room = rooms.get(id);
      if (!room) {
        room = createBrosvsbrosApp({
          channelId: id,
          pool: context.pool,
          emit: (event, data) => socket.nsp.emit(event, data),
          authorizeToken: (token, from) => context.channels.authorize(id, { ip: clientIp(from) }, ["owner", "mod"], String(token ?? "")),
        });
        rooms.set(id, room);
      }
      await room.ready;
      room.onConnection(socket);
    });
  }

  return { router, attachSocket, onConnection, ready };
}

module.exports = { createBrosvsbrosApp };
