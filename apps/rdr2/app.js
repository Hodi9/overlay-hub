import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { DEFAULT_MISSIONS } from "./missions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENV_PREFIX = "RDR2";
const DB_TABLE = "rdr2_state";
const DEFAULT_PROFILE = "main";
const MATCH_THRESHOLD = 0.75;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Scores how well a normalized capture matches a mission's title: exact or
// substring matches score highest, otherwise a word-overlap ratio.
function scoreMatch(capturedNormalized, targetNormalized) {
  if (!capturedNormalized || !targetNormalized) return 0;
  if (capturedNormalized === targetNormalized) return 1;
  if (capturedNormalized.includes(targetNormalized) || targetNormalized.includes(capturedNormalized)) return 0.9;

  const capturedWords = new Set(capturedNormalized.split(" ").filter((w) => w.length >= 3));
  const targetWords = targetNormalized.split(" ").filter((w) => w.length >= 3);
  if (!targetWords.length) return 0;
  const hits = targetWords.filter((w) => capturedWords.has(w)).length;
  return hits / targetWords.length;
}

function sanitizeProfileId(raw) {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")
    .slice(0, 32);
  return cleaned || DEFAULT_PROFILE;
}

function cleanMission(input) {
  return {
    id: (input && input.id) || crypto.randomUUID(),
    day: String((input && input.name) ?? (input && input.day) ?? "").trim().slice(0, 80),
    location: String((input && input.location) ?? "").trim().slice(0, 60),
    part: (input && (input.chapter ?? input.part)) || null
  };
}

// Save headers only contain the mission title, so match on that alone
// (chapter/location are display metadata, not part of the match).
function missionMatchText(mission) {
  return mission.day;
}

/**
 * RDR2's story isn't played linearly — chapters mix main missions with
 * optional/side content you can tackle in whatever order you like, and a
 * chapter's missions don't have to be completed top-to-bottom. So unlike the
 * shared storyTracker.js (used by GTA5/TLOU2/Mafia, which is a single
 * "current position" pointer), this app tracks a *set* of completed
 * missions. Completing one mission only ever moves the percentage by
 * 1/total, whichever mission it is — clicking a mission far down the list
 * never marks everything above it done too.
 */
export function createRdr2App() {
  const router = express.Router();
  const publicDir = path.join(__dirname, "public");
  const controlPassword = process.env[`${ENV_PREFIX}_CONTROL_PASSWORD`] || "";
  const trackerKey = process.env[`${ENV_PREFIX}_TRACKER_KEY`] || "";
  const controlHeader = `x-${ENV_PREFIX.toLowerCase()}-key`;

  let db = null;
  const profiles = new Map(); // profileId -> { chapters, completed: Set<number>, lastCompletedIndex, lastCapture }
  const listeners = new Map(); // profileId -> Set<response>
  const loading = new Map(); // profileId -> Promise (in-flight DB load)

  function authorizedControl(request) {
    if (!controlPassword) return true;
    const key = String(request.headers[controlHeader] || "");
    return safeEqual(key, controlPassword);
  }

  function requireControlAuth(request, response, next) {
    if (authorizedControl(request)) return next();
    return response.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  function authorizedTracker(request) {
    if (!trackerKey) return false;
    const header = String(request.headers.authorization || "");
    return safeEqual(header, `Bearer ${trackerKey}`);
  }

  function profileFromRequest(request) {
    return sanitizeProfileId(request.query.profile || request.body?.profile);
  }

  function dbRowId(profileId) {
    return profileId === DEFAULT_PROFILE ? "primary" : `${ENV_PREFIX.toLowerCase()}:${profileId}`;
  }

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

  function defaultProfileState() {
    return {
      chapters: DEFAULT_MISSIONS.map((m) => cleanMission({ day: m.name, location: m.location, part: m.chapter })),
      completed: new Set(),
      lastCompletedIndex: -1,
      lastCapture: null
    };
  }

  async function ensureProfile(profileId) {
    if (profiles.has(profileId)) return profiles.get(profileId);
    if (loading.has(profileId)) return loading.get(profileId);

    const loadPromise = (async () => {
      let state = defaultProfileState();
      if (db) {
        try {
          const result = await db.query(`SELECT data FROM ${DB_TABLE} WHERE id = $1`, [dbRowId(profileId)]);
          const saved = result.rows[0]?.data;
          if (saved && Array.isArray(saved.chapters) && saved.chapters.length) {
            const chapters = saved.chapters.map((c) => cleanMission(c));
            const completedRaw = Array.isArray(saved.completed) ? saved.completed : [];
            state = {
              chapters,
              completed: new Set(completedRaw.filter((n) => Number.isInteger(n) && n >= 0 && n < chapters.length)),
              lastCompletedIndex: Number.isInteger(saved.lastCompletedIndex) ? saved.lastCompletedIndex : -1,
              lastCapture: null
            };
          }
        } catch (error) {
          console.error(`${ENV_PREFIX} profile "${profileId}" load failed; using defaults.`, error);
        }
      }
      profiles.set(profileId, state);
      return state;
    })();

    loading.set(profileId, loadPromise);
    try {
      return await loadPromise;
    } finally {
      loading.delete(profileId);
    }
  }

  async function persist(profileId, state) {
    if (!db) return;
    await db.query(
      `INSERT INTO ${DB_TABLE} (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [
        dbRowId(profileId),
        JSON.stringify({
          chapters: state.chapters,
          completed: Array.from(state.completed),
          lastCompletedIndex: state.lastCompletedIndex
        })
      ]
    );
  }

  function payload(state) {
    const total = state.chapters.length;
    const completedCount = state.completed.size;
    const lastCompleted =
      state.lastCompletedIndex >= 0 && state.lastCompletedIndex < total ? state.chapters[state.lastCompletedIndex] : null;

    return {
      chapters: state.chapters.map((c, i) => ({ ...c, done: state.completed.has(i) })),
      completed: Array.from(state.completed).sort((a, b) => a - b),
      lastCompletedIndex: state.lastCompletedIndex,
      lastCompleted,
      finished: total > 0 && completedCount >= total,
      progress: { completed: completedCount, total },
      percent: total ? Math.round((completedCount / total) * 1000) / 10 : 0,
      lastCapture: state.lastCapture,
      passwordRequired: Boolean(controlPassword),
      trackerConfigured: Boolean(trackerKey),
      updatedAt: new Date().toISOString()
    };
  }

  function broadcast(profileId, state) {
    const set = listeners.get(profileId);
    if (!set || !set.size) return;
    const message = `data: ${JSON.stringify(payload(state))}\n\n`;
    for (const response of set) response.write(message);
  }

  async function commit(profileId, state) {
    await persist(profileId, state);
    broadcast(profileId, state);
  }

  router.use(express.json({ limit: "32kb" }));

  router.get("/api/state", async (request, response, next) => {
    try {
      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);
      response.set("Cache-Control", "no-store");
      response.json(payload(state));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/events", async (request, response, next) => {
    try {
      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);

      response.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      response.flushHeaders();

      if (!listeners.has(profileId)) listeners.set(profileId, new Set());
      const set = listeners.get(profileId);
      set.add(response);
      response.write(`data: ${JSON.stringify(payload(state))}\n\n`);
      const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20000);
      request.on("close", () => {
        clearInterval(keepAlive);
        set.delete(response);
      });
    } catch (error) {
      next(error);
    }
  });

  // Called by the local save-file tracker script with whatever mission title
  // it read out of the save. Matches against ALL missions (not just the ones
  // "ahead" of some pointer) since the game lets you tackle a chapter's
  // missions out of order — matching the single best-scoring mission and
  // marking just that one done.
  router.post("/api/tracker", async (request, response, next) => {
    try {
      if (!authorizedTracker(request)) {
        return response.status(401).json({ error: "Unauthorized" });
      }
      const text = typeof request.body?.text === "string" ? request.body.text.slice(0, 500) : "";
      if (!text) return response.status(400).json({ error: "text is required" });

      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);
      const capturedNormalized = normalize(text);

      let bestIndex = -1;
      let bestScore = 0;
      for (let i = 0; i < state.chapters.length; i++) {
        const score = scoreMatch(capturedNormalized, normalize(missionMatchText(state.chapters[i])));
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      const matched = bestScore >= MATCH_THRESHOLD;
      state.lastCapture = { text, matched, atISO: new Date().toISOString() };

      if (matched && !state.completed.has(bestIndex)) {
        state.completed.add(bestIndex);
        state.lastCompletedIndex = bestIndex;
        await commit(profileId, state);
      } else {
        broadcast(profileId, state);
      }

      response.json({
        ok: true,
        matched,
        matchedChapter: matched ? state.chapters[bestIndex] : null,
        progress: { completed: state.completed.size, total: state.chapters.length }
      });
    } catch (error) {
      next(error);
    }
  });

  // Toggles ONE mission's done/undone status. This only ever changes that
  // single mission's contribution to the percentage — it never implies
  // anything about missions before or after it in the list.
  router.patch("/api/current", requireControlAuth, async (request, response, next) => {
    try {
      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);
      const index = Number(request.body?.index);
      if (!Number.isInteger(index) || index < 0 || index >= state.chapters.length) {
        return response.status(400).json({ error: "index er ugyldigt." });
      }

      let done = request.body?.done;
      if (typeof done !== "boolean") done = !state.completed.has(index);

      if (done) {
        state.completed.add(index);
        state.lastCompletedIndex = index;
      } else {
        state.completed.delete(index);
        if (state.lastCompletedIndex === index) state.lastCompletedIndex = -1;
      }

      await commit(profileId, state);
      response.json(payload(state));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/chapters", requireControlAuth, async (request, response, next) => {
    try {
      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);
      const list = Array.isArray(request.body?.chapters) ? request.body.chapters : null;
      if (!list || !list.length) return response.status(400).json({ error: "chapters skal være en ikke-tom liste." });

      state.chapters = list.map((c) => cleanMission(c));
      state.completed = new Set(Array.from(state.completed).filter((i) => i < state.chapters.length));
      if (state.lastCompletedIndex >= state.chapters.length) state.lastCompletedIndex = -1;

      await commit(profileId, state);
      response.json(payload(state));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/reset", requireControlAuth, async (request, response, next) => {
    try {
      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);
      state.completed = new Set();
      state.lastCompletedIndex = -1;
      state.lastCapture = null;
      await commit(profileId, state);
      response.json(payload(state));
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: `${ENV_PREFIX}-servicen kunne ikke gemme ændringen.` });
  });

  router.use(express.static(publicDir, { extensions: ["html"] }));

  if (!controlPassword) {
    console.log(`ADVARSEL: ${ENV_PREFIX}_CONTROL_PASSWORD er ikke sat — panelet er ubeskyttet for alle med linket.`);
  }
  if (!trackerKey) {
    console.log(`ADVARSEL: ${ENV_PREFIX}_TRACKER_KEY er ikke sat — den automatiske tracker kan ikke sende opdateringer.`);
  }

  connectDatabase().catch((error) => {
    console.error(`${ENV_PREFIX} database connection failed; using in-memory state.`, error);
  });

  return router;
}
