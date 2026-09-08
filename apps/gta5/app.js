import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { DEFAULT_MISSIONS } from "./missions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

const CHARACTERS = new Set(["michael", "franklin", "trevor"]);

function cleanMission(input) {
  return {
    id: (input && input.id) || crypto.randomUUID(),
    name: String((input && input.name) || "").trim().slice(0, 80),
    character: CHARACTERS.has(input?.character) ? input.character : null
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

function matchText(mission) {
  return normalize(mission.name);
}

// Scores how well a normalized save-title capture matches a mission name:
// exact/substring matches score highest, otherwise a word-overlap ratio.
function scoreMatch(capturedNormalized, missionNormalized) {
  if (!capturedNormalized || !missionNormalized) return 0;
  if (capturedNormalized === missionNormalized) return 1;
  if (capturedNormalized.includes(missionNormalized) || missionNormalized.includes(capturedNormalized)) return 0.9;

  const capturedWords = new Set(capturedNormalized.split(" ").filter((w) => w.length >= 3));
  const missionWords = missionNormalized.split(" ").filter((w) => w.length >= 3);
  if (!missionWords.length) return 0;
  const hits = missionWords.filter((w) => capturedWords.has(w)).length;
  return hits / missionWords.length;
}

const MATCH_THRESHOLD = 0.75;
const LOOKAHEAD = 5;
const DEFAULT_PROFILE = "main";

// Multiple people (e.g. you and a friend) can run their own separate
// playthrough on this same deployment. Each profile is its own isolated
// slot: own mission list, own current position, own SSE listeners. "main"
// keeps the original database row name ("primary") so existing installs
// don't lose their progress when this was added.
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
  return profileId === DEFAULT_PROFILE ? "primary" : `gta5:${profileId}`;
}

export function createGta5App() {
  const router = express.Router();
  const controlPassword = process.env.GTA5_CONTROL_PASSWORD || "";
  const trackerKey = process.env.GTA5_TRACKER_KEY || "";

  let db = null;
  const profiles = new Map(); // profileId -> { missions, currentIndex, lastCapture }
  const listeners = new Map(); // profileId -> Set<response>
  const loading = new Map(); // profileId -> Promise (in-flight DB load)

  function authorizedControl(request) {
    if (!controlPassword) return true;
    const key = String(request.headers["x-gta5-key"] || "");
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
      CREATE TABLE IF NOT EXISTS gta5_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  function defaultProfileState() {
    return { missions: DEFAULT_MISSIONS.map((m) => cleanMission(m)), currentIndex: -1, lastCapture: null };
  }

  async function ensureProfile(profileId) {
    if (profiles.has(profileId)) return profiles.get(profileId);
    if (loading.has(profileId)) return loading.get(profileId);

    const loadPromise = (async () => {
      let state = defaultProfileState();
      if (db) {
        try {
          const result = await db.query("SELECT data FROM gta5_state WHERE id = $1", [dbRowId(profileId)]);
          const saved = result.rows[0]?.data;
          if (saved && Array.isArray(saved.missions) && saved.missions.length) {
            state = {
              missions: saved.missions.map((m) => cleanMission(m)),
              currentIndex: Number.isInteger(saved.currentIndex) ? saved.currentIndex : -1,
              lastCapture: null
            };
          }
        } catch (error) {
          console.error(`GTA5 profile "${profileId}" load failed; using defaults.`, error);
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
      `INSERT INTO gta5_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [dbRowId(profileId), JSON.stringify({ missions: state.missions, currentIndex: state.currentIndex })]
    );
  }

  function payload(state) {
    const completed = Math.max(0, state.currentIndex);
    const total = state.missions.length;
    return {
      missions: state.missions,
      currentIndex: state.currentIndex,
      current: state.currentIndex >= 0 ? state.missions[state.currentIndex] : null,
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

  // Called by the local save-file tracker script with the parsed save title.
  // ?profile=<id> (or body.profile) selects whose playthrough to update;
  // omitted/invalid falls back to the "main" profile.
  router.post("/api/tracker", async (request, response, next) => {
    try {
      if (!authorizedTracker(request)) {
        return response.status(401).json({ error: "Unauthorized" });
      }
      const text = typeof request.body?.text === "string" ? request.body.text.slice(0, 500) : "";
      if (!text) return response.status(400).json({ error: "text is required" });
      const percent = typeof request.body?.percent === "number" ? request.body.percent : null;

      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);

      const capturedNormalized = normalize(text);
      const rangeStart = Math.max(0, state.currentIndex);
      const rangeEnd = Math.min(state.missions.length - 1, state.currentIndex + LOOKAHEAD);

      let bestIndex = -1;
      let bestScore = 0;
      for (let i = rangeStart; i <= rangeEnd; i++) {
        const score = scoreMatch(capturedNormalized, matchText(state.missions[i]));
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      const matched = bestScore >= MATCH_THRESHOLD;
      state.lastCapture = { text, percent, matched, atISO: new Date().toISOString() };

      if (matched && bestIndex !== state.currentIndex) {
        state.currentIndex = bestIndex;
        await commit(profileId, state);
      } else {
        broadcast(profileId, state);
      }

      response.json({
        ok: true,
        matched,
        matchedMission: matched ? state.missions[bestIndex] : null,
        progress: { completed: Math.max(0, state.currentIndex), total: state.missions.length }
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
      if (!Number.isInteger(index) || index < -1 || index >= state.missions.length) {
        return response.status(400).json({ error: "index er ugyldigt." });
      }
      state.currentIndex = index;
      await commit(profileId, state);
      response.json(payload(state));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/missions", requireControlAuth, async (request, response, next) => {
    try {
      const profileId = profileFromRequest(request);
      const state = await ensureProfile(profileId);
      const list = Array.isArray(request.body?.missions) ? request.body.missions : null;
      if (!list || !list.length) return response.status(400).json({ error: "missions skal være en ikke-tom liste." });
      state.missions = list.map((m) => cleanMission(m));
      if (state.currentIndex >= state.missions.length) state.currentIndex = state.missions.length - 1;
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
    response.status(500).json({ error: "GTA5-servicen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!controlPassword) {
    console.log("ADVARSEL: GTA5_CONTROL_PASSWORD er ikke sat — gta5-panelet er ubeskyttet for alle med linket.");
  }
  if (!trackerKey) {
    console.log("ADVARSEL: GTA5_TRACKER_KEY er ikke sat — den automatiske save-tracker kan ikke sende opdateringer.");
  }

  connectDatabase().catch((error) => {
    console.error("GTA5 database connection failed; using in-memory state.", error);
  });

  return router;
}
