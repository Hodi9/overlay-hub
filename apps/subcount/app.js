import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import tmi from "tmi.js";
import { isModOrBroadcaster, parseGoalCommand } from "./commands.js";
import { createTwitchApi } from "./twitchApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_TABLE = "subcount_state";
const CHANNEL_RE = /^[a-z0-9_]{2,25}$/;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function createSubcountApp() {
  const router = express.Router();
  const env = process.env;
  const controlPassword = env.SUBCOUNT_CONTROL_PASSWORD || "";
  const chatCommand = (env.SUBCOUNT_CHAT_COMMAND || "!subgoal").toLowerCase();
  const pollMs = Math.max(10, Number(env.SUBCOUNT_POLL_SECONDS) || 30) * 1000;
  // Twitch's subscription total includes the broadcaster's own free sub.
  const offset = Number.isFinite(Number(env.SUBCOUNT_OFFSET)) && env.SUBCOUNT_OFFSET !== undefined && env.SUBCOUNT_OFFSET !== ""
    ? Number(env.SUBCOUNT_OFFSET) : -1;
  const twitch = env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET
    ? createTwitchApi({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET })
    : null;

  const state = {
    goal: Math.max(0, Math.trunc(Number(env.SUBCOUNT_DEFAULT_GOAL) || 0)),
    subs: null,
    channel: CHANNEL_RE.test(env.SUBCOUNT_TWITCH_CHANNEL || "") ? env.SUBCOUNT_TWITCH_CHANNEL.toLowerCase() : null,
    broadcasterId: null,
    refreshToken: env.SUBCOUNT_REFRESH_TOKEN || null,
    accessToken: null,
    lastError: null
  };
  const listeners = new Set();
  const pendingStates = new Map(); // oauth state -> expiry (ms)
  let db = null;
  let chatClient = null;
  let pollTimer = null;

  // ---------- persistence ----------
  async function connectDatabase() {
    if (!env.DATABASE_URL) return;
    db = new pg.Pool({
      connectionString: env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${DB_TABLE} (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const saved = (await db.query(`SELECT data FROM ${DB_TABLE} WHERE id = 'main'`)).rows[0]?.data;
    if (saved) {
      if (Number.isFinite(saved.goal)) state.goal = Math.max(0, Math.trunc(saved.goal));
      state.refreshToken = state.refreshToken || saved.refreshToken || null;
      state.broadcasterId = saved.broadcasterId || null;
      state.channel = state.channel || saved.channel || null;
    }
  }

  async function persist() {
    if (!db) return;
    await db.query(
      `INSERT INTO ${DB_TABLE} (id, data, updated_at) VALUES ('main', $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify({
        goal: state.goal, refreshToken: state.refreshToken,
        broadcasterId: state.broadcasterId, channel: state.channel
      })]
    );
  }

  // ---------- broadcasting ----------
  function payload() {
    return {
      subs: state.subs,
      goal: state.goal,
      channel: state.channel,
      chatCommand,
      authorized: Boolean(state.refreshToken),
      error: state.lastError,
      updatedAt: new Date().toISOString()
    };
  }

  function broadcast() {
    const message = `data: ${JSON.stringify(payload())}\n\n`;
    for (const response of listeners) response.write(message);
  }

  async function setGoal(goal, via) {
    if (goal === state.goal) return;
    state.goal = goal;
    console.log(`subcount: goal set to ${goal} (${via})`);
    broadcast();
    await persist().catch((error) => console.error("subcount: failed to save goal.", error));
  }

  // ---------- Twitch sub polling ----------
  let refreshing = null;
  function refreshAccessToken() {
    refreshing ||= twitch.refresh(state.refreshToken)
      .then(async (tokens) => {
        state.accessToken = tokens.accessToken;
        if (tokens.refreshToken && tokens.refreshToken !== state.refreshToken) {
          state.refreshToken = tokens.refreshToken;
          await persist().catch((error) => console.error("subcount: failed to save refresh token.", error));
        }
      })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  async function withToken(call) {
    if (!state.accessToken) await refreshAccessToken();
    try {
      return await call(state.accessToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      await refreshAccessToken();
      return call(state.accessToken);
    }
  }

  async function pollOnce() {
    if (!twitch || !state.refreshToken) return;
    try {
      if (!state.broadcasterId) {
        const self = await withToken((token) => twitch.getSelf(token));
        state.broadcasterId = self.id;
        state.channel = state.channel || self.login;
        await persist().catch(() => {});
      }
      const total = await withToken((token) => twitch.getSubTotal(state.broadcasterId, token));
      const subs = Math.max(0, total + offset);
      const changed = subs !== state.subs || state.lastError;
      state.subs = subs;
      state.lastError = null;
      if (changed) broadcast();
      ensureChat();
    } catch (error) {
      console.error("subcount: poll failed.", error.message);
      // 400/401 after a refresh attempt means the grant was revoked or lacks the scope.
      state.lastError = error.status === 401 || error.status === 400
        ? "Twitch-adgangen er udløbet eller mangler — log ind igen via /subcount/auth/login."
        : "Kunne ikke hente subs fra Twitch lige nu.";
      broadcast();
    }
  }

  function startPolling() {
    if (pollTimer || !twitch) return;
    pollOnce();
    pollTimer = setInterval(pollOnce, pollMs);
    pollTimer.unref?.();
  }

  // ---------- chat commands ----------
  function ensureChat() {
    if (chatClient || !state.channel) return;
    chatClient = new tmi.Client({ connection: { reconnect: true, secure: true }, channels: [state.channel] });
    chatClient.on("message", (_channel, tags, message, self) => {
      if (self || !isModOrBroadcaster(tags)) return;
      const goal = parseGoalCommand(message, chatCommand, state.goal);
      if (goal !== null) setGoal(goal, `chat:${tags["display-name"] || tags.username}`);
    });
    const client = chatClient;
    client.connect().catch((error) => {
      console.error("subcount: Twitch chat connection failed.", error);
      client.disconnect().catch(() => {});
      chatClient = null;
    });
  }

  // ---------- auth helpers ----------
  const ready = connectDatabase()
    .catch((error) => console.error("subcount database connection failed; using in-memory state.", error))
    .then(() => {
      ensureChat();
      startPolling();
    });

  function authorizedControl(request) {
    if (!controlPassword) return true;
    const key = String(request.headers["x-subcount-key"] || request.query.key || "");
    return safeEqual(key, controlPassword);
  }

  function requireControlAuth(request, response, next) {
    if (authorizedControl(request)) return next();
    return response.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  function redirectUri(request) {
    const base = env.SUBCOUNT_PUBLIC_URL
      ? env.SUBCOUNT_PUBLIC_URL.replace(/\/+$/, "")
      : `${request.headers["x-forwarded-proto"] || request.protocol}://${request.get("host")}`;
    return `${base}/subcount/auth/callback`;
  }

  // ---------- routes ----------
  router.use(express.json({ limit: "4kb" }));

  router.get("/api/state", async (_request, response) => {
    await ready;
    response.set("Cache-Control", "no-store");
    response.json(payload());
  });

  router.get("/api/events", async (request, response) => {
    await ready;
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

  // Backup way to set the goal besides chat: POST {"goal": 500} with x-subcount-key.
  router.post("/api/goal", requireControlAuth, async (request, response) => {
    const value = Number(request.body?.goal);
    if (!Number.isFinite(value) || value < 0) {
      return response.status(400).json({ error: "goal skal være et positivt tal." });
    }
    await setGoal(Math.trunc(value), "api");
    response.json(payload());
  });

  router.get("/auth/login", requireControlAuth, (request, response) => {
    if (!twitch) {
      return response.status(500).send("Sæt TWITCH_CLIENT_ID og TWITCH_CLIENT_SECRET først.");
    }
    const oauthState = crypto.randomBytes(16).toString("hex");
    pendingStates.set(oauthState, Date.now() + 10 * 60 * 1000);
    response.redirect(twitch.authorizeUrl(redirectUri(request), oauthState));
  });

  router.get("/auth/callback", async (request, response) => {
    const expiry = pendingStates.get(String(request.query.state || ""));
    pendingStates.delete(String(request.query.state || ""));
    if (!expiry || expiry < Date.now() || !twitch) {
      return response.status(400).send("Ugyldigt eller udløbet login-forsøg. Start forfra fra /subcount/auth/login.");
    }
    if (request.query.error || !request.query.code) {
      return response.status(400).send("Twitch-login blev afvist.");
    }
    try {
      const tokens = await twitch.exchangeCode(String(request.query.code), redirectUri(request));
      state.accessToken = tokens.accessToken;
      state.refreshToken = tokens.refreshToken;
      const self = await twitch.getSelf(tokens.accessToken);
      state.broadcasterId = self.id;
      state.channel = state.channel || self.login;
      await persist();
      startPolling();
      pollOnce();
      const persisted = Boolean(db);
      response.type("html").send(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px">` +
        `<h1>Forbundet som ${self.login} ✓</h1>` +
        (persisted
          ? `<p>Login er gemt i databasen. Du kan lukke siden.</p>`
          : `<p>Der er ingen <code>DATABASE_URL</code>, så login forsvinder ved genstart. ` +
            `Sæt denne som miljøvariablen <code>SUBCOUNT_REFRESH_TOKEN</code> for at beholde det:</p>` +
            `<pre style="white-space:pre-wrap;word-break:break-all;background:#eee;padding:12px">${tokens.refreshToken}</pre>`)
      );
    } catch (error) {
      console.error("subcount: OAuth callback failed.", error.message);
      response.status(500).send("Kunne ikke gennemføre Twitch-login. Tjek TWITCH_CLIENT_ID/SECRET og redirect-URL'en.");
    }
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "subcount-servicen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!twitch) console.log("subcount: TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET er ikke sat — sub-tallet kan ikke hentes.");
  if (!controlPassword) console.log("ADVARSEL: SUBCOUNT_CONTROL_PASSWORD er ikke sat — /subcount/auth/login og /api/goal er ubeskyttet.");

  return router;
}
