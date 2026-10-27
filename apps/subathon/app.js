import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { CONTROL_ROLES, sanitizeTwitch } from "../_lib/channels.js";
import { createTwitchSubHub } from "./twitchSubs.js";
import {
  LIMITS, ValidationError, addTime, cleanGoals, cleanSettings, createGiftTracker, goalProgress, pauseTimer,
  registerSubs, resetTimer, restoreState, serializeState, startTimer, timerView, undoTestEvents
} from "./logic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_TABLE = "subathon_state";
const LEGACY_KEY = "main";
const SIMULATED_KINDS = ["sub", "resub", "subgift", "submysterygift"];

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Hub channels (apps/_lib/channels.js) keep their subathon under "hub:<id>". The page without
// ?profile= is the original one (key "main"), protected by SUBATHON_CONTROL_PASSWORD. A channel's
// Twitch name, set on its channel page, only decides which chat the subs are read from; the main
// one has its Twitch name set in the control panel (SUBATHON_TWITCH_CHANNEL is the first value).
export function createSubathonApp({ channels: hubChannels = null, pool = null, hub = null, now = Date.now } = {}) {
  const router = express.Router();
  const controlPassword = process.env.SUBATHON_CONTROL_PASSWORD || "";
  const defaultTwitch = sanitizeTwitch(process.env.SUBATHON_TWITCH_CHANNEL || "");
  const chat = hub || createTwitchSubHub();

  let db = null;
  const slots = new Map(); // state key -> { state, listeners, gifts, saveChain }
  const loading = new Map(); // state key -> Promise<slot>
  const joining = new Set();

  async function connectDatabase() {
    if (!pool && !process.env.DATABASE_URL) return;
    const { Pool } = pg;
    db = pool || new Pool({
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
    console.error("subathon database connection failed; using in-memory state.", error);
    db = null;
  });

  function loadSlot(key) {
    if (slots.has(key)) return Promise.resolve(slots.get(key));
    if (loading.has(key)) return loading.get(key);
    const promise = (async () => {
      let saved = null;
      if (db) {
        try {
          const result = await db.query(`SELECT data FROM ${DB_TABLE} WHERE id = $1`, [key]);
          saved = result.rows[0]?.data ?? null;
        } catch (error) {
          console.error(`subathon: failed to load state for ${key}.`, error);
        }
      }
      const state = restoreState(saved, { twitch: key === LEGACY_KEY ? defaultTwitch : null });
      const slot = { state, listeners: new Set(), gifts: createGiftTracker(), saveChain: Promise.resolve() };
      slots.set(key, slot);
      loading.delete(key);
      return slot;
    })();
    loading.set(key, promise);
    return promise;
  }

  // Writes are queued per subathon, so a slow save can never land after a newer one.
  function persist(key, slot) {
    if (!db) return Promise.resolve();
    const data = JSON.stringify(serializeState(slot.state));
    slot.saveChain = slot.saveChain.catch(() => {}).then(() => db.query(
      `INSERT INTO ${DB_TABLE} (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [key, data]
    ));
    return slot.saveChain;
  }

  function twitchOf(key, state) {
    return key === LEGACY_KEY ? state.twitch : hubChannels?.get(key.slice(4))?.twitch || null;
  }

  function payload(key, slot) {
    const at = now();
    const progress = goalProgress(slot.state.goals, slot.state.count);
    const twitch = twitchOf(key, slot.state);
    return {
      timer: timerView(slot.state.timer, at),
      count: slot.state.count,
      goals: progress.goals,
      nextGoalId: progress.next?.id ?? null,
      settings: slot.state.settings,
      events: slot.state.events.slice(0, 20),
      twitch,
      twitchEditable: key === LEGACY_KEY,
      chatConnected: Boolean(twitch) && chat.isJoined(twitch),
      passwordRequired: key !== LEGACY_KEY || Boolean(controlPassword)
    };
  }

  function broadcast(key, slot) {
    if (!slot.listeners.size) return;
    const message = `data: ${JSON.stringify(payload(key, slot))}\n\n`;
    for (const response of slot.listeners) response.write(message);
  }

  // The in-memory state is already updated by the time this runs, so tell the live viewers (the
  // overlay, control panels) first. A slow or failing database write must not hold the timer back; it
  // still surfaces as an error to whoever made the change.
  async function commit(key, slot) {
    broadcast(key, slot);
    await persist(key, slot);
  }

  // Joins the chat the subs are read from, without making the request that asked for it wait.
  function watchChat(key, slot) {
    const twitch = twitchOf(key, slot.state);
    if (!twitch || chat.isJoined(twitch) || joining.has(twitch)) return;
    joining.add(twitch);
    chat.ensureJoined(twitch).then((ok) => {
      joining.delete(twitch);
      if (ok) for (const [otherKey, other] of slots) if (twitchOf(otherKey, other.state) === twitch) broadcast(otherKey, other);
    });
  }

  // One line from chat (or from the panel's test buttons) goes through here: the gift matching decides
  // how many subs it is worth, then the time, the counter and the event list are updated.
  async function applySub(key, event, { test = false } = {}) {
    const slot = await loadSlot(key);
    const at = now();
    const credit = slot.gifts.credit(event, at);
    const entry = registerSubs(slot.state, {
      kind: event.kind, user: event.user, recipient: event.recipient, tier: credit.tier, count: credit.count, test
    }, at);
    if (!entry) return null;
    await commit(key, slot);
    return entry;
  }

  chat.onSub((twitch, event) => {
    for (const [key, slot] of slots) {
      if (twitchOf(key, slot.state) !== twitch) continue;
      applySub(key, event).catch((error) => console.error(`subathon: could not save a sub in #${twitch}.`, error));
    }
  });

  // After a restart the chats of subathons that are in progress are joined again at once, so subs
  // keep counting even when no overlay has been opened yet.
  async function resume() {
    await ready;
    await hubChannels?.ready;
    watchChat(LEGACY_KEY, await loadSlot(LEGACY_KEY));
    if (!db) return;
    const result = await db.query(
      `SELECT id FROM ${DB_TABLE} WHERE id <> $1 AND data->'timer'->>'status' IN ('running', 'paused')`,
      [LEGACY_KEY]
    );
    for (const row of result.rows) watchChat(row.id, await loadSlot(row.id));
  }
  resume().catch((error) => console.error("subathon: could not resume the chats.", error));

  // ---- requests --------------------------------------------------------------------------

  function hubChannelOf(request) {
    const id = request.query.profile;
    return typeof id === "string" && hubChannels && hubChannels.has(id) ? id : null;
  }

  function authorizedControl(request) {
    const hubId = hubChannelOf(request);
    if (hubId) return hubChannels.authorize(hubId, request, CONTROL_ROLES);
    if (!controlPassword) return true;
    return safeEqual(String(request.headers["x-subathon-key"] || ""), controlPassword);
  }

  function requireControlAuth(request, response, next) {
    if (authorizedControl(request)) return next();
    return response.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  async function withSlot(request, response, next) {
    if (request.query.profile && !hubChannelOf(request)) return response.status(404).json({ error: "Ukendt kanal." });
    await ready;
    const hubId = hubChannelOf(request);
    request.key = hubId ? `hub:${hubId}` : LEGACY_KEY;
    request.slot = await loadSlot(request.key);
    watchChat(request.key, request.slot);
    next();
  }

  const secondsOf = (raw, label) => {
    const value = Number(raw);
    if (raw === null || raw === "" || raw === undefined || !Number.isFinite(value) || Math.abs(value) > LIMITS.timerSeconds) {
      throw new ValidationError(`${label} skal være et tal.`);
    }
    return value;
  };

  router.use(express.json({ limit: "16kb" }));

  router.get("/api/state", withSlot, (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(payload(request.key, request.slot));
  });

  router.get("/api/events", withSlot, (request, response) => {
    const { key, slot } = request;
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.flushHeaders();
    slot.listeners.add(response);
    response.write(`data: ${JSON.stringify(payload(key, slot))}\n\n`);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20000);
    request.on("close", () => {
      clearInterval(keepAlive);
      slot.listeners.delete(response);
    });
  });

  // Every change from the panel: check it, apply it, tell everybody, save it, answer with the new state.
  function change(path, apply) {
    router.post(path, withSlot, requireControlAuth, async (request, response) => {
      const { key, slot } = request;
      await apply(slot.state, request.body || {}, slot, key);
      await commit(key, slot);
      response.json(payload(key, slot));
    });
  }

  change("/api/timer/start", (state) => { state.timer = startTimer(state.timer, now()); });
  change("/api/timer/pause", (state) => { state.timer = pauseTimer(state.timer, now()); });

  // Manual changes are the streamer's own call, so they ignore the maximum time.
  change("/api/timer/add", (state, body) => {
    state.timer = addTime(state.timer, Math.round(secondsOf(body.seconds, "Tid") * 1000), now(), { revive: true }).timer;
  });

  change("/api/reset", (state, body) => {
    state.timer = resetTimer(state.settings.startSeconds * 1000);
    if (body.what === "all") {
      state.count = 0;
      state.events = [];
    }
  });

  change("/api/settings", (state, body) => {
    state.settings = cleanSettings(body, state.settings);
    // A timer that has not started yet follows the start time.
    if (state.timer.status === "idle" && state.timer.addedMs === 0) state.timer = resetTimer(state.settings.startSeconds * 1000);
  });

  change("/api/count", (state, body) => {
    const next = body.count !== undefined ? Number(body.count) : state.count + Number(body.delta);
    if (!Number.isInteger(next) || next < 0 || next > LIMITS.count) throw new ValidationError("Antallet skal være et helt tal på 0 eller derover.");
    state.count = next;
  });

  change("/api/goals", (state, body) => { state.goals = cleanGoals(body.goals); });

  change("/api/twitch", (state, body, slot, key) => {
    if (key !== LEGACY_KEY) throw new ValidationError("Twitch-kanalen sættes på kanal-siden under Indstillinger.");
    const raw = String(body.twitch ?? "").trim();
    const twitch = sanitizeTwitch(raw);
    if (raw && !twitch) throw new ValidationError("Det ligner ikke et Twitch-kanalnavn.");
    state.twitch = twitch;
    watchChat(key, slot);
  });

  change("/api/undo-tests", (state) => { undoTestEvents(state, now()); });

  // A test sub takes the same road as one from chat (gift matching, time, counter), only marked as a test.
  router.post("/api/simulate", withSlot, requireControlAuth, async (request, response) => {
    const { key, slot } = request;
    const kind = request.body?.kind;
    const tier = Math.trunc(Number(request.body?.tier ?? 1));
    if (!SIMULATED_KINDS.includes(kind) || ![1, 2, 3].includes(tier)) {
      throw new ValidationError("Ukendt type eller tier.");
    }
    const count = kind === "submysterygift" ? Math.trunc(Number(request.body?.count ?? 5)) : 1;
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new ValidationError("Antal gaver skal være mellem 1 og 100.");
    const testId = crypto.randomBytes(4).toString("hex"); // each test gift is its own gifter, so tests never merge
    await applySub(key, {
      id: null,
      kind,
      channel: twitchOf(key, slot.state) || "",
      user: kind === "sub" || kind === "resub" ? "Test viewer" : "Test gifter",
      login: `test-${testId}`,
      anonymous: false,
      tier,
      prime: false,
      count,
      recipient: kind === "subgift" ? "Test recipient" : null,
      giftKeys: kind === "subgift" || kind === "submysterygift" ? [`o:test-${testId}`] : []
    }, { test: true });
    response.json(payload(key, slot));
  });

  router.use((error, _request, response, _next) => {
    if (error instanceof ValidationError) return response.status(error.status).json({ error: error.message });
    if (error.type === "entity.parse.failed" || error.type === "entity.too.large") return response.status(400).json({ error: "Ugyldig forespørgsel." });
    console.error(error);
    response.status(500).json({ error: "Subathon-servicen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) {
    console.log("ADVARSEL: SUBATHON_CONTROL_PASSWORD er ikke sat — panelet er ubeskyttet for alle med linket.");
  }

  return router;
}
