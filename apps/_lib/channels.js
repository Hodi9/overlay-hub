import crypto from "node:crypto";
import express from "express";

// Channels let anyone run their own copy of the overlays on this hub without a
// shared password. A channel has a random public id (it goes in overlay links as
// ?profile=<id>) and three kinds of secret keys, stored only as SHA-256 hashes:
//   owner   - may do everything, including handing out mod keys
//   mod     - may change things in the control panels
//   tracker - may only feed progress from a local tracker script
// The keys are 130 random bits, so they cannot be guessed or calculated from the
// channel id; failed attempts are rate limited on top of that.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 12;
const KEY_LENGTH = 26;
const MAX_MODS = 10;
const TWITCH_RE = /^[a-z0-9_]{2,25}$/;

export const CHANNEL_ID_RE = /^[a-z2-7]{12}$/;
export const CONTROL_ROLES = ["owner", "mod"];
export const TRACKER_ROLES = ["owner", "tracker"];

// 256 is a multiple of 32, so taking a byte modulo 32 is unbiased.
export function randomToken(length) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function hashKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

function hashesEqual(a, b) {
  const left = Buffer.from(String(a), "hex");
  const right = Buffer.from(String(b), "hex");
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function sanitizeTwitch(raw) {
  const cleaned = String(raw || "").trim().toLowerCase().replace(/^#/, "");
  return TWITCH_RE.test(cleaned) ? cleaned : null;
}

// Counts events per key inside a fixed window; used for failed logins and for
// channel creation. Old entries are dropped whenever the map grows large.
export function createCounter({ windowMs, max }) {
  const entries = new Map();

  function current(key, now) {
    const entry = entries.get(key);
    return entry && now - entry.start < windowMs ? entry : null;
  }

  return {
    blocked(key, now = Date.now()) {
      const entry = current(key, now);
      return Boolean(entry) && entry.count >= max;
    },
    hit(key, now = Date.now()) {
      let entry = current(key, now);
      if (!entry) {
        entry = { start: now, count: 0 };
        entries.set(key, entry);
      }
      entry.count += 1;
      if (entries.size > 10000) {
        for (const [name, value] of entries) if (now - value.start >= windowMs) entries.delete(name);
      }
      return entry.count;
    }
  };
}

// The key can arrive in several shapes: the x-channel-key header the browser
// shim adds, an Authorization bearer token (local tracker scripts), or one of
// the app-specific x-...-key headers the old password boxes still send.
export function keyFromRequest(request) {
  const headers = request?.headers || {};
  if (headers["x-channel-key"]) return String(headers["x-channel-key"]).trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || ""));
  if (bearer) return bearer[1].trim();
  for (const name of Object.keys(headers)) {
    if (/^x-[a-z0-9-]+-key$/.test(name) && headers[name]) return String(headers[name]).trim();
  }
  return "";
}

function publicRecord(record) {
  return { id: record.id, twitch: record.twitch || null, createdAt: record.createdAt };
}

/**
 * All channels live in memory (there are at most `limit` of them, a few hundred
 * bytes each) and are mirrored to the hub_channels table when there is a
 * database, so that checking a key never needs a query.
 */
export function createChannelRegistry({ pool = null, limit = Number(process.env.CHANNEL_LIMIT) || 500 } = {}) {
  const channels = new Map();
  const failures = createCounter({ windowMs: 10 * 60 * 1000, max: 40 });

  async function persist(record) {
    if (!pool) return;
    await pool.query(
      `INSERT INTO hub_channels (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [record.id, JSON.stringify(record)]
    );
  }

  async function init() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hub_channels (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await pool.query("SELECT data FROM hub_channels");
    for (const row of result.rows) {
      if (row.data?.id) channels.set(row.data.id, row.data);
    }
  }

  // Server startup should not fail just because the database is down: the
  // channels then simply look unknown (which fails closed) until a restart.
  const ready = init().catch((error) => {
    console.error("channels: could not load channels from the database.", error);
  });

  function newId() {
    for (;;) {
      const id = randomToken(ID_LENGTH);
      if (!channels.has(id)) return id;
    }
  }

  function role(id, key) {
    const record = channels.get(id);
    if (!record || !key) return null;
    const hash = hashKey(key);
    let found = null;
    if (hashesEqual(hash, record.ownerHash)) found = "owner";
    else if (hashesEqual(hash, record.trackerHash)) found = "tracker";
    else if (record.mods.some((mod) => hashesEqual(hash, mod.hash))) found = "mod";
    return found;
  }

  // Failed attempts are counted per visitor and per scope (a channel id, or "admin"), so somebody
  // who keeps guessing at one channel cannot lock anyone out of the others.
  const bucket = (request, scope) => `${request.ip || request.socket?.remoteAddress || "unknown"}|${scope}`;
  const isLockedOut = (request, scope) => failures.blocked(bucket(request, scope));
  const recordFailure = (request, scope) => failures.hit(bucket(request, scope));

  // True when the request carries a key with one of the allowed roles. A caller
  // that keeps failing is locked out for a while, even if it later guesses right.
  function authorize(id, request, roles = CONTROL_ROLES, key = keyFromRequest(request)) {
    if (isLockedOut(request, id)) return false;
    const found = role(id, key == null ? "" : String(key));
    if (found && roles.includes(found)) return true;
    recordFailure(request, id);
    return false;
  }

  async function create({ twitch = null } = {}) {
    if (channels.size >= limit) {
      const error = new Error("Der er ikke plads til flere kanaler lige nu.");
      error.status = 503;
      throw error;
    }
    const ownerKey = `o_${randomToken(KEY_LENGTH)}`;
    const trackerKey = `t_${randomToken(KEY_LENGTH)}`;
    const record = {
      id: newId(),
      ownerHash: hashKey(ownerKey),
      trackerHash: hashKey(trackerKey),
      mods: [],
      twitch: sanitizeTwitch(twitch),
      createdAt: new Date().toISOString()
    };
    channels.set(record.id, record);
    try {
      await persist(record);
    } catch (error) {
      channels.delete(record.id);
      throw error;
    }
    return { id: record.id, ownerKey, trackerKey, record: publicRecord(record) };
  }

  async function mutate(id, change) {
    const record = channels.get(id);
    if (!record) return null;
    const before = structuredClone(record);
    const result = change(record);
    try {
      await persist(record);
    } catch (error) {
      channels.set(id, before);
      throw error;
    }
    return result;
  }

  return {
    ready,
    get: (id) => channels.get(id) || null,
    has: (id) => channels.has(id),
    count: () => channels.size,
    publicRecord: (id) => (channels.has(id) ? publicRecord(channels.get(id)) : null),
    modList: (id) => (channels.get(id)?.mods || []).map((mod) => ({ id: mod.id, label: mod.label, createdAt: mod.createdAt })),
    findByTwitch: (name) => [...channels.values()].filter((record) => record.twitch && record.twitch === name).map((record) => record.id),
    role,
    authorize,
    isLockedOut,
    recordFailure,
    create,

    addMod(id, label) {
      return mutate(id, (record) => {
        if (record.mods.length >= MAX_MODS) {
          const error = new Error(`En kanal kan højst have ${MAX_MODS} mod-nøgler.`);
          error.status = 400;
          throw error;
        }
        const key = `m_${randomToken(KEY_LENGTH)}`;
        const mod = {
          id: randomToken(8),
          label: String(label || "").trim().slice(0, 40) || "Moderator",
          hash: hashKey(key),
          createdAt: new Date().toISOString()
        };
        record.mods.push(mod);
        return { mod: { id: mod.id, label: mod.label, createdAt: mod.createdAt }, key };
      });
    },

    removeMod(id, modId) {
      return mutate(id, (record) => {
        const before = record.mods.length;
        record.mods = record.mods.filter((mod) => mod.id !== modId);
        return record.mods.length < before;
      });
    },

    rotate(id, which) {
      return mutate(id, (record) => {
        if (which === "owner") {
          const key = `o_${randomToken(KEY_LENGTH)}`;
          record.ownerHash = hashKey(key);
          return key;
        }
        if (which === "tracker") {
          const key = `t_${randomToken(KEY_LENGTH)}`;
          record.trackerHash = hashKey(key);
          return key;
        }
        return null;
      });
    },

    update(id, { twitch }) {
      return mutate(id, (record) => {
        if (twitch !== undefined) record.twitch = sanitizeTwitch(twitch);
        return publicRecord(record);
      });
    },

    async remove(id) {
      if (!channels.delete(id)) return false;
      if (pool) await pool.query("DELETE FROM hub_channels WHERE id = $1", [id]);
      return true;
    }
  };
}

/**
 * The HTTP API behind the /kanal/ page. Creating a channel is open to everyone
 * (rate limited per IP); everything else needs the channel's owner key.
 * `adminKey` (HUB_ADMIN_KEY) lets the host reset the keys of a channel whose
 * owner lost them, or delete a channel that is being abused.
 */
export function createChannelsRouter({ registry, adminKey = process.env.HUB_ADMIN_KEY || "" }) {
  const router = express.Router();
  const createLimit = createCounter({ windowMs: 60 * 60 * 1000, max: 6 });

  router.use(express.json({ limit: "4kb" }));

  function adminAuthorized(request) {
    if (!adminKey || registry.isLockedOut(request, "admin")) return false;
    if (safeEqual(request.headers["x-admin-key"] || "", adminKey)) return true;
    registry.recordFailure(request, "admin");
    return false;
  }

  function known(request, response, next) {
    if (!registry.has(request.params.id)) return response.status(404).json({ error: "Ukendt kanal." });
    next();
  }

  function requireOwner(request, response, next) {
    if (registry.isLockedOut(request, request.params.id)) return response.status(429).json({ error: "For mange forkerte forsøg. Prøv igen om lidt." });
    if (registry.authorize(request.params.id, request, ["owner"])) return next();
    return response.status(401).json({ error: "Forkert eller manglende nøgle." });
  }

  function failure(response, error) {
    console.error(error);
    response.status(error.status || 500).json({ error: error.status ? error.message : "Kanal-servicen kunne ikke gemme ændringen." });
  }

  router.post("/", async (request, response) => {
    const ip = request.ip || "unknown";
    if (createLimit.blocked(ip)) {
      return response.status(429).json({ error: "Du har lavet mange kanaler på kort tid. Prøv igen senere." });
    }
    createLimit.hit(ip);
    try {
      const created = await registry.create({ twitch: request.body?.twitch });
      response.status(201).json(created);
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/:id", known, (request, response) => {
    response.json(registry.publicRecord(request.params.id));
  });

  // Who am I? Used by the channel page and the control panels' banner.
  router.get("/:id/me", known, (request, response) => {
    if (registry.isLockedOut(request, request.params.id)) return response.status(429).json({ error: "For mange forkerte forsøg. Prøv igen om lidt." });
    const found = registry.role(request.params.id, keyFromRequest(request));
    if (!found) {
      registry.recordFailure(request, request.params.id);
      return response.status(401).json({ error: "Forkert eller manglende nøgle." });
    }
    response.json({
      role: found,
      channel: registry.publicRecord(request.params.id),
      mods: found === "owner" ? registry.modList(request.params.id) : []
    });
  });

  router.patch("/:id", known, requireOwner, async (request, response) => {
    try {
      const channel = await registry.update(request.params.id, { twitch: request.body?.twitch });
      response.json({ channel });
    } catch (error) {
      failure(response, error);
    }
  });

  router.post("/:id/mods", known, requireOwner, async (request, response) => {
    try {
      const created = await registry.addMod(request.params.id, request.body?.label);
      response.status(201).json(created);
    } catch (error) {
      failure(response, error);
    }
  });

  router.delete("/:id/mods/:modId", known, requireOwner, async (request, response) => {
    try {
      const removed = await registry.removeMod(request.params.id, request.params.modId);
      if (!removed) return response.status(404).json({ error: "Ukendt mod-nøgle." });
      response.json({ ok: true });
    } catch (error) {
      failure(response, error);
    }
  });

  router.post("/:id/rotate", known, requireOwner, async (request, response) => {
    const which = request.body?.which;
    if (which !== "owner" && which !== "tracker") return response.status(400).json({ error: "which skal være owner eller tracker." });
    try {
      const key = await registry.rotate(request.params.id, which);
      response.json({ which, key });
    } catch (error) {
      failure(response, error);
    }
  });

  // Host-only: new keys for a channel whose owner lost theirs.
  router.post("/:id/admin-reset", known, async (request, response) => {
    if (!adminAuthorized(request)) return response.status(403).json({ error: "Kun serverens ejer kan det." });
    try {
      const ownerKey = await registry.rotate(request.params.id, "owner");
      const trackerKey = await registry.rotate(request.params.id, "tracker");
      response.json({ ownerKey, trackerKey });
    } catch (error) {
      failure(response, error);
    }
  });

  router.delete("/:id", known, async (request, response) => {
    if (!adminAuthorized(request)) return response.status(403).json({ error: "Kun serverens ejer kan det." });
    try {
      await registry.remove(request.params.id);
      response.json({ ok: true });
    } catch (error) {
      failure(response, error);
    }
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(400).json({ error: "Ugyldig forespørgsel." });
  });

  return router;
}

function unknownChannel(request, response) {
  const wantsHtml = String(request.headers.accept || "").includes("text/html");
  if (!wantsHtml) return response.status(404).json({ error: "Ukendt kanal." });
  response.status(404).type("html").send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Ukendt kanal</title><body style="font-family:system-ui,sans-serif;background:#0b0b0d;color:#ededed;padding:48px 20px;max-width:560px;margin:0 auto">` +
    `<h1>Ukendt kanal</h1><p>Kanalen i linket findes ikke. Tjek at linket er kopieret helt, eller <a style="color:#ffd60a" href="/kanal/">lav en ny kanal</a>.</p>`
  );
}

/**
 * For apps that keep their whole state in one closure (Minecraft, Gauntlet, ...):
 * requests without ?profile= go to the existing app, requests with a known
 * channel id go to a copy of the app that only holds that channel's state.
 * Copies are created on demand and dropped again after a while without traffic.
 *
 * `factory(context)` must return an Express router; the context carries the
 * channel's id, the shared database pool and the key checks. A router may expose
 * a `ready` promise that is awaited before its first request.
 */
export function createTenantDispatcher({ registry, pool = null, legacy, factory, idleMs = 30 * 60 * 1000 }) {
  const instances = new Map();

  function contextFor(id) {
    return {
      channelId: id,
      stateId: id,
      pool,
      authorizeControl: (request) => registry.authorize(id, request, CONTROL_ROLES),
      authorizeTracker: (request) => registry.authorize(id, request, TRACKER_ROLES),
      // Any other combination of roles, optionally with an explicit key (login forms).
      authorize: (request, roles, key) => registry.authorize(id, request, roles, key),
      record: () => registry.get(id)
    };
  }

  function instanceFor(id) {
    let entry = instances.get(id);
    if (!entry) {
      entry = { router: factory(contextFor(id)), inflight: 0, lastUsed: Date.now() };
      instances.set(id, entry);
    }
    return entry;
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of instances) {
      if (entry.inflight === 0 && now - entry.lastUsed > idleMs) instances.delete(id);
    }
  }, 5 * 60 * 1000);
  sweeper.unref?.();

  async function middleware(request, response, next) {
    const raw = request.query.profile;
    if (typeof raw !== "string" || raw === "") return legacy(request, response, next);
    if (!registry.has(raw)) return unknownChannel(request, response);

    try {
      const entry = instanceFor(raw);
      if (entry.router.ready) await entry.router.ready;
      entry.inflight += 1;
      entry.lastUsed = Date.now();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        entry.inflight -= 1;
        entry.lastUsed = Date.now();
      };
      response.on("close", release);
      response.on("finish", release);
      entry.router(request, response, next);
    } catch (error) {
      next(error);
    }
  }

  middleware.instanceCount = () => instances.size;
  return middleware;
}
