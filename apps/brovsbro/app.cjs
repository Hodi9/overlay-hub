const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const DEFAULT_DYSTER = ["Dart", "Bowling", "Minigolf", "Brætspil", "Bordfodbold", "Wildcard"];

function defaultDuel() {
  return { points: { marcelo: 0, aggo: 0 }, sets: { marcelo: 0, aggo: 0 } };
}

function defaultPlayers() {
  return {
    marcelo: { name: "Marcelo", image: "/brovsbro/images/marcelo.png", color: "#123f6e" },
    aggo: { name: "Aggo", image: "/brovsbro/images/aggo.png", color: "#d6d6d6" },
  };
}

const MAX_IMAGE_LENGTH = 400000;

function cleanColor(value, fallback) {
  const v = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

function cleanImage(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.length > MAX_IMAGE_LENGTH) return null;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) return v;
  if (/^https:\/\/[^\s"'<>]+$/.test(v) || /^\/brovsbro\/images\/[\w.-]+$/.test(v)) return v;
  return null;
}

function createBrovsbroApp() {
  const router = express.Router();
  const PANEL_KEY = process.env.BROVSBRO_PANEL_KEY || "";
  const STATE_FILE = path.join(process.env.DATA_DIR || __dirname, "brovsbro-state.json");

  function loadState() {
    try {
      const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (!loaded.duel) loaded.duel = defaultDuel();
      if (!loaded.players) loaded.players = defaultPlayers();
      return loaded;
    } catch {
      return {
        scores: { marcelo: 0, aggo: 0 },
        round: 1,
        current: null,
        queue: DEFAULT_DYSTER.map((name) => ({ id: crypto.randomUUID(), name })),
        log: [],
        duel: defaultDuel(),
        players: defaultPlayers(),
      };
    }
  }

  let state = loadState();
  let io = null;

  function saveState() {
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {});
  }

  function playerName(p) {
    return state.players?.[p]?.name || (p === "marcelo" ? "Marcelo" : "Aggo");
  }

  function pushLog(entry) {
    state.log.unshift({ id: crypto.randomUUID(), at: Date.now(), entry });
    state.log = state.log.slice(0, 30);
  }

  function broadcast() {
    if (io) io.emit("state", state);
    saveState();
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

  router.get("/duel", (req, res) => {
    res.redirect(301, "/brovsbro/overlay?view=duel");
  });

  router.get("/", (req, res) => {
    res.redirect("/brovsbro/overlay");
  });

  function authorized(token) {
    if (!PANEL_KEY) return true;
    return token === PANEL_KEY;
  }

  function attachSocket(server) {
    io = new Server(server, { path: "/brovsbro/socket.io", cors: { origin: "*" }, maxHttpBufferSize: 2e6, destroyUpgrade: false });

    io.on("connection", (socket) => {
      socket.emit("state", state);
      socket.emit("config", { dysterPreset: DEFAULT_DYSTER, requiresKey: Boolean(PANEL_KEY) });

      socket.on("panel:action", (payload = {}) => {
        const { type, token } = payload;
        if (!authorized(token)) {
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
            if (p === "marcelo" || p === "aggo") {
              state.scores[p] = Math.max(0, state.scores[p] + 1);
              pushLog(`${playerName(p)} +1 point`);
            }
            break;
          }
          case "score:dec": {
            const p = payload.player;
            if (p === "marcelo" || p === "aggo") {
              state.scores[p] = Math.max(0, state.scores[p] - 1);
              pushLog(`${playerName(p)} -1 point`);
            }
            break;
          }
          case "player:update": {
            const p = payload.player;
            if (p !== "marcelo" && p !== "aggo") return;
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
            pushLog(`Deltager opdateret: ${next.name}`);
            break;
          }
          case "players:reset": {
            state.players = defaultPlayers();
            pushLog("Deltagere nulstillet til standard");
            break;
          }
          case "round:set": {
            const n = Number(payload.value);
            if (Number.isFinite(n) && n > 0) state.round = Math.floor(n);
            break;
          }
          case "corner:set": {
            if (payload.corner === "marcelo" || payload.corner === "aggo") {
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
              state.current = { name: next.name, corner: state.current?.corner || "marcelo" };
              state.round += 1;
              pushLog(`Ny dyst: ${next.name}`);
            }
            break;
          }
          case "dyst:setCurrent": {
            const name = String(payload.name || "").trim();
            if (name) {
              state.current = { name, corner: state.current?.corner || "marcelo" };
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
            state.scores = { marcelo: 0, aggo: 0 };
            pushLog("Scores nulstillet");
            break;
          }
          case "duel:point:inc": {
            const p = payload.player;
            if (p === "marcelo" || p === "aggo") {
              state.duel.points[p] = Math.min(11, state.duel.points[p] + 1);
            }
            break;
          }
          case "duel:point:dec": {
            const p = payload.player;
            if (p === "marcelo" || p === "aggo") {
              state.duel.points[p] = Math.max(0, state.duel.points[p] - 1);
            }
            break;
          }
          case "duel:set:inc": {
            const p = payload.player;
            if (p === "marcelo" || p === "aggo") {
              state.duel.sets[p] += 1;
              pushLog(`${playerName(p)} vandt sæt ${state.duel.sets[p]}`);
            }
            break;
          }
          case "duel:set:dec": {
            const p = payload.player;
            if (p === "marcelo" || p === "aggo") {
              state.duel.sets[p] = Math.max(0, state.duel.sets[p] - 1);
            }
            break;
          }
          case "duel:points:reset": {
            state.duel.points = { marcelo: 0, aggo: 0 };
            pushLog("Duel-point nulstillet (nyt sæt)");
            break;
          }
          case "reset:all": {
            state = {
              scores: { marcelo: 0, aggo: 0 },
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
    });

    if (!PANEL_KEY) {
      console.log("ADVARSEL: BROVSBRO_PANEL_KEY er ikke sat — panelet er ubeskyttet for alle med linket.");
    }
  }

  return { router, attachSocket };
}

module.exports = { createBrovsbroApp };
