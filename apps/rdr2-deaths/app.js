import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { createTwitchDeathHub } from "./twitchChat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_TABLE = "rdr2_deaths_state";
const CHANNEL_RE = /^[a-z0-9_]{2,25}$/;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function sanitizeChannel(raw) {
  const cleaned = String(raw || "").trim().toLowerCase().replace(/^#/, "");
  return CHANNEL_RE.test(cleaned) ? cleaned : null;
}

export function createRdr2DeathsApp() {
  const router = express.Router();
  const controlPassword = process.env.RDR2DEATHS_CONTROL_PASSWORD || "";
  const defaultChannel = sanitizeChannel(process.env.RDR2DEATHS_TWITCH_CHANNEL || "");
  const chatCommand = (process.env.RDR2DEATHS_CHAT_COMMAND || "!died").toLowerCase();

  let db = null;
  const channels = new Map(); // channel -> { count, lastDeathAt, lastTrigger, listeners: Set }

  async function connectDatabase() {
    if (!process.env.DATABASE_URL) return;
    const { Pool } = pg;
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${DB_TABLE} (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
  const ready = connectDatabase().catch((error) => {
    console.error("rdr2-deaths database connection failed; using in-memory state.", error);
  });

  async function loadChannel(channel) {
    if (channels.has(channel)) return channels.get(channel);
    const state = { count: 0, lastDeathAt: null, lastTrigger: null, listeners: new Set() };
    if (db) {
      try {
        const result = await db.query(`SELECT data FROM ${DB_TABLE} WHERE id = $1`, [channel]);
        const saved = result.rows[0]?.data;
        if (saved && Number.isFinite(saved.count)) {
          state.count = Math.max(0, Math.trunc(saved.count));
          state.lastDeathAt = saved.lastDeathAt || null;
        }
      } catch (error) {
        console.error(`rdr2-deaths: failed to load state for #${channel}.`, error);
      }
    }
    channels.set(channel, state);
    return state;
  }

  async function persist(channel, state) {
    if (!db) return;
    await db.query(
      `INSERT INTO ${DB_TABLE} (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [channel, JSON.stringify({ count: state.count, lastDeathAt: state.lastDeathAt })]
    );
  }

  function payload(channel, state) {
    return {
      channel,
      count: state.count,
      lastDeathAt: state.lastDeathAt,
      lastTrigger: state.lastTrigger,
      passwordRequired: Boolean(controlPassword),
      chatConfigured: true,
      chatConnected: chatHub.isJoined(channel),
      chatCommand,
      updatedAt: new Date().toISOString()
    };
  }

  function broadcast(channel, state) {
    const message = `data: ${JSON.stringify(payload(channel, state))}\n\n`;
    for (const response of state.listeners) response.write(message);
  }

  async function commit(channel, state) {
    await persist(channel, state);
    broadcast(channel, state);
  }

  const chatHub = createTwitchDeathHub({ command: chatCommand });
  chatHub.onDeath(async (channel, username) => {
    await ready;
    const state = await loadChannel(channel);
    state.count += 1;
    state.lastDeathAt = new Date().toISOString();
    state.lastTrigger = { via: "chat", username, atISO: state.lastDeathAt };
    await commit(channel, state);
  });

  function authorizedControl(request) {
    if (!controlPassword) return true;
    const key = String(request.headers["x-rdr2deaths-key"] || "");
    return safeEqual(key, controlPassword);
  }

  function requireControlAuth(request, response, next) {
    if (authorizedControl(request)) return next();
    return response.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  function channelFromRequest(request) {
    return sanitizeChannel(request.query.channel) || defaultChannel;
  }

  function requireChannel(request, response, next) {
    const channel = channelFromRequest(request);
    if (!channel) {
      return response.status(400).json({ error: "Angiv et gyldigt Twitch-kanalnavn via ?channel=." });
    }
    request.channel = channel;
    next();
  }

  router.use(express.json({ limit: "16kb" }));

  router.get("/api/state", requireChannel, async (request, response) => {
    await ready;
    const state = await loadChannel(request.channel);
    await chatHub.ensureJoined(request.channel);
    response.set("Cache-Control", "no-store");
    response.json(payload(request.channel, state));
  });

  router.get("/api/events", requireChannel, async (request, response) => {
    await ready;
    const state = await loadChannel(request.channel);
    await chatHub.ensureJoined(request.channel);

    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.flushHeaders();
    state.listeners.add(response);
    response.write(`data: ${JSON.stringify(payload(request.channel, state))}\n\n`);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20000);
    request.on("close", () => {
      clearInterval(keepAlive);
      state.listeners.delete(response);
    });
  });

  router.post("/api/increment", requireChannel, requireControlAuth, async (request, response) => {
    await ready;
    const state = await loadChannel(request.channel);
    state.count += 1;
    state.lastDeathAt = new Date().toISOString();
    state.lastTrigger = { via: "panel", atISO: state.lastDeathAt };
    await commit(request.channel, state);
    response.json(payload(request.channel, state));
  });

  router.post("/api/decrement", requireChannel, requireControlAuth, async (request, response) => {
    await ready;
    const state = await loadChannel(request.channel);
    state.count = Math.max(0, state.count - 1);
    await commit(request.channel, state);
    response.json(payload(request.channel, state));
  });

  router.post("/api/state", requireChannel, requireControlAuth, async (request, response) => {
    await ready;
    const value = Number(request.body?.count);
    if (!Number.isFinite(value) || value < 0) {
      return response.status(400).json({ error: "count skal være et positivt tal." });
    }
    const state = await loadChannel(request.channel);
    state.count = Math.trunc(value);
    await commit(request.channel, state);
    response.json(payload(request.channel, state));
  });

  router.post("/api/reset", requireChannel, requireControlAuth, async (request, response) => {
    await ready;
    const state = await loadChannel(request.channel);
    state.count = 0;
    state.lastDeathAt = null;
    state.lastTrigger = null;
    await commit(request.channel, state);
    response.json(payload(request.channel, state));
  });

  router.get("/api/default-channel", (_request, response) => {
    response.json({ channel: defaultChannel });
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "rdr2-deaths-servicen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) {
    console.log("ADVARSEL: RDR2DEATHS_CONTROL_PASSWORD er ikke sat — panelet er ubeskyttet for alle med linket.");
  }

  return router;
}
