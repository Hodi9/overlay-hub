import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { DEFAULT_MISSIONS } from "./missions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENV_PREFIX = "GTA5";
const DB_TABLE = "gta5_state";
const DEFAULT_PROFILE = "main";
const MATCH_THRESHOLD = 0.75;
const CHARACTERS = new Set(["michael", "franklin", "trevor"]);

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

// Scores how well a normalized capture matches a mission's title: exact
// matches score highest, then substring matches, then a word-overlap ratio.
// The overlap score is capped below the substring score so a partial match
// can never tie with — and, by list order, beat — an exact title (e.g. the
// capture "Trevor Philips Industries" must not match "Mr. Philips").
function scoreMatch(capturedNormalized, targetNormalized) {
  if (!capturedNormalized || !targetNormalized) return 0;
  if (capturedNormalized === targetNormalized) return 1;
  if (capturedNormalized.includes(targetNormalized) || targetNormalized.includes(capturedNormalized)) return 0.9;

  const capturedWords = new Set(capturedNormalized.split(" ").filter((w) => w.length >= 3));
  const targetWords = targetNormalized.split(" ").filter((w) => w.length >= 3);
  if (!targetWords.length) return 0;
  const hits = targetWords.filter((w) => capturedWords.has(w)).length;
  return Math.min(hits / targetWords.length, 0.89);
}

function sanitizeProfileId(raw) {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")
    .slice(0, 32);
  return cleaned || DEFAULT_PROFILE;
}

// Bump when DEFAULT_MISSIONS gains rows that existing saved lists should get.
// A saved list below this version is migrated once on load (see
// migrateSavedList) — deduplicated and topped up with missing defaults —
// and then stamped, so missions the user later removes stay removed.
const LIST_VERSION = 2;

// `part` holds the playable character (michael/franklin/trevor) and is only
// used for the colour tag in the control panel. `optional` rows (heist preps,
// family missions) can be ticked off but don't count toward the percentage.
function cleanMission(input) {
  const character = input?.character ?? input?.part;
  return {
    id: (input && input.id) || crypto.randomUUID(),
    day: String((input && input.name) ?? (input && input.day) ?? "").trim().slice(0, 80),
    location: "",
    part: CHARACTERS.has(character) ? character : null,
    optional: Boolean(input?.optional)
  };
}

// Brings a saved list up to LIST_VERSION: drops exact-duplicate titles (e.g.
// the same mission added twice through "Tilføj som ny mission"), then inserts
// any default mission the list doesn't have yet right after the nearest
// preceding default it does have. Completion and "latest" are carried over by
// mission id, so no checkmark moves.
export function migrateSavedList(chapters, completed, lastCompletedIndex) {
  const doneIds = new Set();
  let lastId = null;
  chapters.forEach((c, i) => {
    if (completed.has(i)) doneIds.add(c.id);
    if (i === lastCompletedIndex) lastId = c.id;
  });

  const firstByTitle = new Map(); // normalized title -> kept chapter
  const merged = [];
  for (const chapter of chapters) {
    const key = normalize(missionMatchText(chapter));
    const kept = firstByTitle.get(key);
    if (kept) {
      // A duplicate that was ticked off ticks off the one we keep.
      if (doneIds.has(chapter.id)) doneIds.add(kept.id);
      if (chapter.id === lastId) lastId = kept.id;
      continue;
    }
    firstByTitle.set(key, chapter);
    merged.push(chapter);
  }

  const defaults = DEFAULT_MISSIONS.map((m) => cleanMission(m));
  const present = new Set(merged.map((c) => normalize(missionMatchText(c))));
  defaults.forEach((d, k) => {
    const key = normalize(missionMatchText(d));
    if (present.has(key)) return;
    let insertAt = 0;
    for (let p = k - 1; p >= 0; p--) {
      const at = merged.findIndex((c) => normalize(missionMatchText(c)) === normalize(missionMatchText(defaults[p])));
      if (at !== -1) {
        insertAt = at + 1;
        break;
      }
    }
    merged.splice(insertAt, 0, d);
    present.add(key);
  });

  const newCompleted = new Set();
  let newLast = -1;
  merged.forEach((c, i) => {
    if (doneIds.has(c.id)) newCompleted.add(i);
    if (lastId !== null && c.id === lastId) newLast = i;
  });
  return { chapters: merged, completed: newCompleted, lastCompletedIndex: newLast };
}

// Save headers only contain the mission title, so match on that alone.
function missionMatchText(mission) {
  return mission.day;
}

/**
 * Like RDR2, this tracks a *set* of completed missions rather than a single
 * "current position" pointer. The save tracker matches the mission title it
 * reads out of your newest save against the WHOLE list — not just the next
 * few missions after some pointer — so it works no matter where you are in
 * the game when the tracker is started (e.g. joining mid-playthrough), and
 * Strangers & Freaks-style detours or out-of-order missions never block it.
 */
export function createGta5App() {
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
      chapters: DEFAULT_MISSIONS.map((m) => cleanMission(m)),
      completed: new Set(),
      lastCompletedIndex: -1,
      lastCapture: null
    };
  }

  // Rebuilds in-memory state from a saved DB row. Rows written by the older
  // pointer-based tracker only have `currentIndex` (everything before it was
  // counted as done), so those are converted to a completed set.
  function stateFromSaved(saved) {
    const chapters = saved.chapters.map((c) => cleanMission(c));
    let completed;
    if (Array.isArray(saved.completed)) {
      completed = new Set(saved.completed.filter((n) => Number.isInteger(n) && n >= 0 && n < chapters.length));
    } else {
      const upTo = Number.isInteger(saved.currentIndex) ? Math.min(saved.currentIndex, chapters.length) : 0;
      completed = new Set();
      for (let i = 0; i < upTo; i++) completed.add(i);
    }
    let lastCompletedIndex = -1;
    if (Number.isInteger(saved.lastCompletedIndex) && saved.lastCompletedIndex < chapters.length) {
      lastCompletedIndex = saved.lastCompletedIndex;
    } else if (completed.size) {
      lastCompletedIndex = Math.max(...completed);
    }
    if ((Number.isInteger(saved.listVersion) ? saved.listVersion : 0) < LIST_VERSION) {
      const migrated = migrateSavedList(chapters, completed, lastCompletedIndex);
      return { ...migrated, lastCapture: null, migrated: true };
    }
    return { chapters, completed, lastCompletedIndex, lastCapture: null };
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
            state = stateFromSaved(saved);
          }
        } catch (error) {
          console.error(`${ENV_PREFIX} profile "${profileId}" load failed; using defaults.`, error);
        }
        if (state.migrated) {
          // Stamp the migrated list right away so it only ever runs once.
          delete state.migrated;
          try {
            await persist(profileId, state);
          } catch (error) {
            console.error(`${ENV_PREFIX} profile "${profileId}" migration save failed.`, error);
          }
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
          listVersion: LIST_VERSION,
          chapters: state.chapters,
          completed: Array.from(state.completed),
          lastCompletedIndex: state.lastCompletedIndex
        })
      ]
    );
  }

  // Progress only counts required (non-optional) missions; ticked-off optional
  // ones (heist preps, family missions) are reported separately.
  function progressOf(state) {
    let total = 0;
    let completed = 0;
    let optionalCompleted = 0;
    state.chapters.forEach((c, i) => {
      const done = state.completed.has(i);
      if (c.optional) {
        if (done) optionalCompleted++;
      } else {
        total++;
        if (done) completed++;
      }
    });
    return { completed, total, optionalCompleted };
  }

  function payload(state) {
    const total = state.chapters.length;
    const progress = progressOf(state);
    const lastCompleted =
      state.lastCompletedIndex >= 0 && state.lastCompletedIndex < total ? state.chapters[state.lastCompletedIndex] : null;

    return {
      chapters: state.chapters.map((c, i) => ({ ...c, done: state.completed.has(i) })),
      completed: Array.from(state.completed).sort((a, b) => a - b),
      lastCompletedIndex: state.lastCompletedIndex,
      lastCompleted,
      finished: progress.total > 0 && progress.completed >= progress.total,
      progress,
      percent: progress.total ? Math.round((progress.completed / progress.total) * 1000) / 10 : 0,
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

  // Called by the local save-file tracker script with the mission title it
  // read out of your newest save. Matches against ALL missions and marks the
  // single best-scoring one as done.
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

      if (matched && (!state.completed.has(bestIndex) || state.lastCompletedIndex !== bestIndex)) {
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
        progress: progressOf(state)
      });
    } catch (error) {
      next(error);
    }
  });

  // Toggles ONE mission's done/undone status. With `through: true` (and
  // done != false) it also marks every required mission before it as done —
  // handy for catching up after joining mid-playthrough, since GTA V's story
  // is mostly linear. Optional rows (heist preps, family missions) are left
  // alone because you only play some of them.
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
        if (request.body?.through === true) {
          for (let i = 0; i < index; i++) {
            if (!state.chapters[i].optional) state.completed.add(i);
          }
        }
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

  // Replaces the mission list (add/remove from the control panel). Completion
  // is carried over by mission id so removing a mission in the middle doesn't
  // shift everyone below it onto the wrong checkmark.
  router.put("/api/chapters", requireControlAuth, async (request, response, next) => {
    try {
      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);
      const list = Array.isArray(request.body?.chapters) ? request.body.chapters : null;
      if (!list || !list.length) return response.status(400).json({ error: "chapters skal være en ikke-tom liste." });

      const doneIds = new Set();
      let lastId = null;
      state.chapters.forEach((c, i) => {
        if (state.completed.has(i)) doneIds.add(c.id);
        if (i === state.lastCompletedIndex) lastId = c.id;
      });

      state.chapters = list.map((c) => cleanMission(c));
      state.completed = new Set();
      state.lastCompletedIndex = -1;
      state.chapters.forEach((c, i) => {
        if (doneIds.has(c.id)) state.completed.add(i);
        if (lastId !== null && c.id === lastId) state.lastCompletedIndex = i;
      });

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
