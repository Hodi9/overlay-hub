import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { DEFAULT_CHAPTERS } from "./chapters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function cleanChapter(input) {
  return {
    id: (input && input.id) || crypto.randomUUID(),
    day: String((input && input.day) || "").trim().slice(0, 60),
    location: String((input && input.location) || "").trim().slice(0, 60),
    part: input && input.part === "abby" ? "abby" : "ellie"
  };
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchText(chapter) {
  return normalize(`${chapter.day} ${chapter.location}`);
}

// Scores how well a normalized OCR capture matches a chapter's day/location
// text: exact/substring matches score highest, otherwise a word-overlap ratio.
function scoreMatch(ocrNormalized, chapterNormalized) {
  if (!ocrNormalized || !chapterNormalized) return 0;
  if (ocrNormalized === chapterNormalized) return 1;
  if (ocrNormalized.includes(chapterNormalized) || chapterNormalized.includes(ocrNormalized)) return 0.9;

  const ocrWords = new Set(ocrNormalized.split(" ").filter((w) => w.length >= 3));
  const chapterWords = chapterNormalized.split(" ").filter((w) => w.length >= 3);
  if (!chapterWords.length) return 0;
  const hits = chapterWords.filter((w) => ocrWords.has(w)).length;
  return hits / chapterWords.length;
}

const MATCH_THRESHOLD = 0.75;
const LOOKAHEAD = 3;
const DEFAULT_PROFILE = "main";

// Multiple people (e.g. you and a friend) can run their own separate
// marathon on this same deployment. Each profile is its own isolated slot:
// own chapter list, own current position, own SSE listeners. "main" keeps
// the original database row name ("primary") so existing installs don't
// lose their progress when this was added.
function sanitizeProfileId(raw) {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")
    .slice(0, 32);
  return cleaned || DEFAULT_PROFILE;
}

function profileFromRequest(request) {
  return sanitizeProfileId(request.query.profile || request.body?.profile);
}

function dbRowId(profileId) {
  return profileId === DEFAULT_PROFILE ? "primary" : `tlou2:${profileId}`;
}

export function createTlou2App() {
  const router = express.Router();
  const controlPassword = process.env.TLOU2_CONTROL_PASSWORD || "";
  const trackerKey = process.env.TLOU2_TRACKER_KEY || "";

  let db = null;
  const profiles = new Map(); // profileId -> { chapters, currentIndex, lastOcr }
  const listeners = new Map(); // profileId -> Set<response>
  const loading = new Map(); // profileId -> Promise (in-flight DB load, so concurrent requests don't double-load)

  function authorizedControl(request) {
    if (!controlPassword) return true;
    const key = String(request.headers["x-tlou2-key"] || "");
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

  async function connectDatabase() {
    if (!process.env.DATABASE_URL) return;
    const { Pool } = pg;
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });

    await db.query(`
      CREATE TABLE IF NOT EXISTS tlou2_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  function defaultProfileState() {
    return { chapters: DEFAULT_CHAPTERS.map((c) => cleanChapter(c)), currentIndex: -1, lastOcr: null };
  }

  async function ensureProfile(profileId) {
    if (profiles.has(profileId)) return profiles.get(profileId);
    if (loading.has(profileId)) return loading.get(profileId);

    const loadPromise = (async () => {
      let state = defaultProfileState();
      if (db) {
        try {
          const result = await db.query("SELECT data FROM tlou2_state WHERE id = $1", [dbRowId(profileId)]);
          const saved = result.rows[0]?.data;
          if (saved && Array.isArray(saved.chapters) && saved.chapters.length) {
            state = {
              chapters: saved.chapters.map((c) => cleanChapter(c)),
              currentIndex: Number.isInteger(saved.currentIndex) ? saved.currentIndex : -1,
              lastOcr: null
            };
          }
        } catch (error) {
          console.error(`TLOU2 profile "${profileId}" load failed; using defaults.`, error);
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
      `INSERT INTO tlou2_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [dbRowId(profileId), JSON.stringify({ chapters: state.chapters, currentIndex: state.currentIndex })]
    );
  }

  function payload(state) {
    const completed = Math.max(0, state.currentIndex);
    const total = state.chapters.length;
    return {
      chapters: state.chapters,
      currentIndex: state.currentIndex,
      current: state.currentIndex >= 0 ? state.chapters[state.currentIndex] : null,
      progress: { completed, total },
      percent: total ? Math.round((completed / total) * 1000) / 10 : 0,
      lastOcr: state.lastOcr,
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

  // Called by the local OCR tracker script with raw recognized text.
  // ?profile=<id> (or body.profile) selects whose marathon to update;
  // omitted/invalid falls back to the "main" profile.
  router.post("/api/tracker", async (request, response, next) => {
    try {
      if (!authorizedTracker(request)) {
        return response.status(401).json({ error: "Unauthorized" });
      }
      const text = typeof request.body?.text === "string" ? request.body.text.slice(0, 500) : "";
      if (!text) return response.status(400).json({ error: "text is required" });

      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);

      const ocrNormalized = normalize(text);
      const rangeStart = Math.max(0, state.currentIndex);
      const rangeEnd = Math.min(state.chapters.length - 1, state.currentIndex + LOOKAHEAD);

      let bestIndex = -1;
      let bestScore = 0;
      for (let i = rangeStart; i <= rangeEnd; i++) {
        const score = scoreMatch(ocrNormalized, matchText(state.chapters[i]));
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      const matched = bestScore >= MATCH_THRESHOLD;
      state.lastOcr = { text, matched, atISO: new Date().toISOString() };

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
      if (!Number.isInteger(index) || index < -1 || index >= state.chapters.length) {
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
      if (state.currentIndex >= state.chapters.length) state.currentIndex = state.chapters.length - 1;
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
      state.lastOcr = null;
      await commit(profileId, state);
      response.json(payload(state));
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "TLOU2-servicen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) {
    console.log("ADVARSEL: TLOU2_CONTROL_PASSWORD er ikke sat — tlou2-panelet er ubeskyttet for alle med linket.");
  }
  if (!trackerKey) {
    console.log("ADVARSEL: TLOU2_TRACKER_KEY er ikke sat — den automatiske OCR-tracker kan ikke sende opdateringer.");
  }

  connectDatabase().catch((error) => {
    console.error("TLOU2 database connection failed; using in-memory state.", error);
  });

  return router;
}
