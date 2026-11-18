import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { MAX_COUNTERS, bump, chatAmount, cleanChannel, cleanCommand, commandTaken, counterForCommand, defaultState, editCounter, makeCounter, reorder, restore } from "./state.js";
import { createChatListener } from "./chat.js";
import { CONTROL_ROLES } from "../_lib/channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Two mods typing !death for the same death within this window count once.
export const CHAT_COOLDOWN_MS = 5000;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// GTA VI-tællere: overlay på /gta6-counters/, panel på /gta6-counters/control.html. Mods og streameren kan tælle op
// med en chat-kommando (fx !death), når en Twitch-kanal er sat i panelet. Tests sender chat: null og deres egen now.
// Hub channels (?profile=<id>, apps/_lib/channels.js) each get their own counters, saved as "hub:<id>", their own
// chat and the channel's owner/mod keys instead of the password. Instances are kept (not swept) so chat keeps counting.
export function createGta6CountersApp({ pool = null, channels = null, chat: chatOption, now = () => Date.now() } = {}) {
  const legacy = createCountersInstance({ pool, chat: chatOption, now, stateId: "primary", useEnv: true });
  const hubInstances = new Map();

  function hubInstance(id) {
    let instance = hubInstances.get(id);
    if (!instance) {
      instance = createCountersInstance({
        pool, now, stateId: `hub:${id}`,
        chat: chatOption === undefined ? undefined : chatOption && chatOption.forChannel ? chatOption.forChannel(id) : null,
        authorizeControl: (request) => channels.authorize(id, request, CONTROL_ROLES)
      });
      hubInstances.set(id, instance);
    }
    return instance;
  }

  // After a restart, channels that had a Twitch chat set start listening again without anyone opening the page.
  const resumed = (async () => {
    if (!pool || !channels) return;
    await legacy.ready;
    const { rows } = await pool.query("SELECT id FROM gta6_counters_state WHERE id LIKE 'hub:%' AND COALESCE(data->>'channel', '') <> ''");
    for (const row of rows) {
      const id = row.id.slice(4);
      if (channels.has(id)) hubInstance(id);
    }
  })().catch((error) => console.error("gta6-counters: could not resume channel chats.", error));

  const router = (req, res, next) => {
    const id = req.query.profile;
    if (typeof id !== "string" || id === "" || !channels) return legacy(req, res, next);
    if (!channels.has(id)) return res.status(404).json({ error: "Ukendt kanal." });
    hubInstance(id)(req, res, next);
  };
  router.onChat = legacy.onChat; // for tests
  router.hubInstance = hubInstance; // for tests
  router.resumed = resumed;
  return router;
}

function createCountersInstance({ pool, chat: chatOption, now, stateId, useEnv = false, authorizeControl = null }) {
  const router = express.Router();
  const controlPassword = authorizeControl ? "" : process.env.GTA6COUNTERS_CONTROL_PASSWORD || "";
  let state = defaultState();
  const envChannel = useEnv ? cleanChannel(process.env.GTA6COUNTERS_TWITCH_CHANNEL || "") : "";
  if (envChannel) state.channel = envChannel;
  let lastChange = null;
  let db = pool;
  const lastChatBump = new Map();
  const listeners = new Set();

  const chat = chatOption === undefined ? createChatListener({ onMessage: (message, username) => onChat(message, username) }) : chatOption;

  const requireAuth = (req, res, next) => {
    const ok = authorizeControl ? authorizeControl(req) : !controlPassword || safeEqual(req.headers["x-gta6counters-key"] || "", controlPassword);
    if (ok) return next();
    res.status(401).json({ error: "Forkert eller manglende adgangskode." });
  };

  const ready = (async () => {
    if (db) {
      await db.query(`CREATE TABLE IF NOT EXISTS gta6_counters_state (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      const { rows } = await db.query("SELECT data FROM gta6_counters_state WHERE id = $1", [stateId]);
      if (rows[0]) state = restore(rows[0].data);
    }
  })().catch((error) => {
    console.error("gta6-counters: database unavailable; using in-memory state.", error);
    db = null;
  }).then(() => { if (state.channel) chat?.follow(state.channel); });
  router.ready = ready;

  const payload = () => ({ ...state, lastChange, chatChannel: chat ? chat.channel() : "", passwordRequired: Boolean(controlPassword), hubChannel: Boolean(authorizeControl) });

  function commit(next, change = null) {
    state = next;
    if (change) lastChange = { ...change, at: new Date(now()).toISOString() };
    db?.query(
      `INSERT INTO gta6_counters_state (id, data, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [stateId, JSON.stringify(state)]
    ).catch((error) => console.error("gta6-counters: could not save state.", error));
    const message = `data: ${JSON.stringify(payload())}\n\n`;
    for (const response of listeners) response.write(message);
    return payload();
  }

  const replaceCounter = (counter) => ({ ...state, counters: state.counters.map((c) => (c.id === counter.id ? counter : c)) });

  function onChat(message, username) {
    const counter = counterForCommand(state.counters, message);
    if (!counter) return;
    const amount = chatAmount(message);
    if (amount !== null) {
      // "!death 50" sets the counter; no cooldown, the last one typed wins.
      if (amount === counter.count) return;
      commit(replaceCounter({ ...counter, count: amount }), { id: counter.id, by: amount - counter.count, set: amount, via: "chat", username });
      return;
    }
    const t = now();
    if (t - (lastChatBump.get(counter.id) || -Infinity) < CHAT_COOLDOWN_MS) return;
    lastChatBump.set(counter.id, t);
    commit(replaceCounter(bump(counter, 1)), { id: counter.id, by: 1, via: "chat", username });
  }

  router.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    ready.then(() => next(), next);
  });
  router.use(express.json({ limit: "8kb" }));

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

  router.post("/api/login", requireAuth, (_req, res) => res.json({ ok: true }));

  const findCounter = (req, res) => {
    const counter = state.counters.find((c) => c.id === req.params.id);
    if (!counter) res.status(404).json({ error: "Tælleren findes ikke." });
    return counter;
  };

  router.post("/api/counters/:id/bump", requireAuth, (req, res) => {
    const counter = findCounter(req, res);
    if (!counter) return;
    const by = req.body?.by === -1 ? -1 : 1;
    res.json(commit(replaceCounter(bump(counter, by)), { id: counter.id, by, via: "panel" }));
  });

  router.patch("/api/counters/:id", requireAuth, (req, res) => {
    const counter = findCounter(req, res);
    if (!counter) return;
    const result = editCounter(counter, req.body);
    if (result.error) return res.status(400).json({ error: result.error });
    if (commandTaken(state.counters, result.counter.command, counter.id)) return res.status(400).json({ error: `${result.counter.command} bruges allerede af en anden tæller.` });
    res.json(commit(replaceCounter(result.counter)));
  });

  router.post("/api/counters", requireAuth, (req, res) => {
    if (state.counters.length >= MAX_COUNTERS) return res.status(400).json({ error: `Højst ${MAX_COUNTERS} tællere.` });
    const command = cleanCommand(req.body?.command);
    if (command === null) return res.status(400).json({ error: "Kommandoen skal være ! og op til 24 bogstaver/tal, fx !death." });
    if (commandTaken(state.counters, command)) return res.status(400).json({ error: `${command} bruges allerede af en anden tæller.` });
    if (!String(req.body?.label ?? "").trim()) return res.status(400).json({ error: "Skriv et navn." });
    res.json(commit({ ...state, counters: [...state.counters, makeCounter({ label: req.body.label, command })] }));
  });

  router.delete("/api/counters/:id", requireAuth, (req, res) => {
    if (!findCounter(req, res)) return;
    res.json(commit({ ...state, counters: state.counters.filter((c) => c.id !== req.params.id) }));
  });

  router.put("/api/order", requireAuth, (req, res) => res.json(commit({ ...state, counters: reorder(state.counters, req.body?.ids) })));

  router.post("/api/reset-all", requireAuth, (_req, res) => res.json(commit({ ...state, counters: state.counters.map((c) => ({ ...c, count: 0 })) })));

  router.patch("/api/settings", requireAuth, async (req, res) => {
    const channel = cleanChannel(req.body?.channel);
    if (channel === null) return res.status(400).json({ error: "Det ligner ikke et Twitch-navn." });
    commit({ ...state, channel });
    await chat?.follow(channel);
    res.json(commit(state));
  });

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    console.error("gta6-counters:", error);
    res.status(error.status || 500).json({ error: "Tællerne kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (useEnv && !controlPassword) console.log("ADVARSEL: GTA6COUNTERS_CONTROL_PASSWORD er ikke sat — tæller-panelet er ubeskyttet for alle med linket.");

  router.onChat = onChat; // for tests
  return router;
}
