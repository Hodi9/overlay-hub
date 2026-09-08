import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import pg from "pg";

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

// Scores how well a normalized capture matches a chapter's text: exact or
// substring matches score highest, otherwise a word-overlap ratio. Shared by
// every story tracker (OCR-based or save-file-based).
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

const MATCH_THRESHOLD = 0.75;
const LOOKAHEAD = 5;
const DEFAULT_PROFILE = "main";

function sanitizeProfileId(raw) {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")
    .slice(0, 32);
  return cleaned || DEFAULT_PROFILE;
}

/**
 * Builds a self-contained Express router for a "story progress tracker":
 * an ordered chapter list, a current-position pointer, manual control-panel
 * overrides, and a capture ingest endpoint (fed by an OCR script or a
 * save-file watcher) that fuzzy-matches captured text against upcoming
 * chapters. Used by tlou2, gta5, and the Mafia trilogy trackers so the
 * matching/persistence/profile logic only exists once.
 *
 * @param {object} options
 * @param {string} options.publicDir - absolute path to the app's public/ folder
 * @param {string} options.envPrefix - e.g. "TLOU2" -> reads TLOU2_CONTROL_PASSWORD / TLOU2_TRACKER_KEY
 * @param {string} options.dbTable - Postgres table name for this tracker's state
 * @param {Array<object>} options.defaultChapters - seed chapter list
 * @param {(input: object) => object} options.cleanChapter - normalizes/validates one chapter object
 * @param {(chapter: object) => string} options.matchText - text to fuzzy-match a capture against
 */
export function createStoryTrackerApp(options) {
  const { publicDir, envPrefix, dbTable, defaultChapters, cleanChapter, matchText } = options;

  const router = express.Router();
  const controlPassword = process.env[`${envPrefix}_CONTROL_PASSWORD`] || "";
  const trackerKey = process.env[`${envPrefix}_TRACKER_KEY`] || "";
  const controlHeader = `x-${envPrefix.toLowerCase()}-key`;

  let db = null;
  const profiles = new Map(); // profileId -> { chapters, currentIndex, lastCapture }
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
    const expected = `Bearer ${trackerKey}`;
    return safeEqual(header, expected);
  }

  function profileFromRequest(request) {
    return sanitizeProfileId(request.query.profile || request.body?.profile);
  }

  function dbRowId(profileId) {
    return profileId === DEFAULT_PROFILE ? "primary" : `${envPrefix.toLowerCase()}:${profileId}`;
  }

  async function connectDatabase() {
    if (!process.env.DATABASE_URL) return;
    const { Pool } = pg;
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });

    await db.query(`
      CREATE TABLE IF NOT EXISTS ${dbTable} (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  function defaultProfileState() {
    return { chapters: defaultChapters.map((c) => cleanChapter(c)), currentIndex: -1, lastCapture: null };
  }

  async function ensureProfile(profileId) {
    if (profiles.has(profileId)) return profiles.get(profileId);
    if (loading.has(profileId)) return loading.get(profileId);

    const loadPromise = (async () => {
      let state = defaultProfileState();
      if (db) {
        try {
          const result = await db.query(`SELECT data FROM ${dbTable} WHERE id = $1`, [dbRowId(profileId)]);
          const saved = result.rows[0]?.data;
          if (saved && Array.isArray(saved.chapters) && saved.chapters.length) {
            state = {
              chapters: saved.chapters.map((c) => cleanChapter(c)),
              currentIndex: Number.isInteger(saved.currentIndex) ? saved.currentIndex : -1,
              lastCapture: null
            };
          }
        } catch (error) {
          console.error(`${envPrefix} profile "${profileId}" load failed; using defaults.`, error);
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
      `INSERT INTO ${dbTable} (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [dbRowId(profileId), JSON.stringify({ chapters: state.chapters, currentIndex: state.currentIndex })]
    );
  }

  function payload(state) {
    const total = state.chapters.length;
    const finished = state.currentIndex >= total;
    const completed = finished ? total : Math.max(0, state.currentIndex);
    return {
      chapters: state.chapters,
      currentIndex: state.currentIndex,
      current: state.currentIndex >= 0 && state.currentIndex < total ? state.chapters[state.currentIndex] : null,
      finished,
      progress: { completed, total },
      percent: total ? Math.round((completed / total) * 1000) / 10 : 0,
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

  // Called by the local tracker script (OCR or save-file watcher) with
  // whatever raw text it captured. ?profile=<id> (or body.profile) selects
  // whose progress to update; omitted/invalid falls back to "main".
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
      const rangeStart = Math.max(0, state.currentIndex);
      const rangeEnd = Math.min(state.chapters.length - 1, state.currentIndex + LOOKAHEAD);

      let bestIndex = -1;
      let bestScore = 0;
      for (let i = rangeStart; i <= rangeEnd; i++) {
        const score = scoreMatch(capturedNormalized, normalize(matchText(state.chapters[i])));
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      const matched = bestScore >= MATCH_THRESHOLD;
      state.lastCapture = { text, matched, atISO: new Date().toISOString() };

      if (matched && bestIndex !== state.currentIndex) {
        state.currentIndex = bestIndex;
        await commit(profileId, state);
      } else {
        broadcast(profileId, state);
      }

      response.json({
        ok: true,
        matched,
        matchedChapter: matched ? state.chapters[bestIndex] : null,
        progress: { completed: Math.max(0, state.currentIndex), total: state.chapters.length }
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/current", requireControlAuth, async (request, response, next) => {
    try {
      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);
      const index = Number(request.body?.index);
      if (!Number.isInteger(index) || index < -1 || index > state.chapters.length) {
        return response.status(400).json({ error: "index er ugyldigt." });
      }
      state.currentIndex = index;
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
      state.chapters = list.map((c) => cleanChapter(c));
      if (state.currentIndex > state.chapters.length) state.currentIndex = state.chapters.length;
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
      state.currentIndex = -1;
      state.lastCapture = null;
      await commit(profileId, state);
      response.json(payload(state));
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: `${envPrefix}-servicen kunne ikke gemme ændringen.` });
  });

  router.use(express.static(publicDir, { extensions: ["html"] }));

  if (!controlPassword) {
    console.log(`ADVARSEL: ${envPrefix}_CONTROL_PASSWORD er ikke sat — panelet er ubeskyttet for alle med linket.`);
  }
  if (!trackerKey) {
    console.log(`ADVARSEL: ${envPrefix}_TRACKER_KEY er ikke sat — den automatiske tracker kan ikke sende opdateringer.`);
  }

  connectDatabase().catch((error) => {
    console.error(`${envPrefix} database connection failed; using in-memory state.`, error);
  });

  return router;
}

export function makeDayLocationCleaner() {
  return function cleanChapter(input) {
    return {
      id: (input && input.id) || crypto.randomUUID(),
      day: String((input && input.day) || "").trim().slice(0, 60),
      location: String((input && input.location) || "").trim().slice(0, 60),
      part: (input && input.part) || null
    };
  };
}

export function dayLocationMatchText(chapter) {
  return `${chapter.day} ${chapter.location}`;
}
