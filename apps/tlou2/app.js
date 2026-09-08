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

export function createTlou2App() {
  const router = express.Router();
  const controlPassword = process.env.TLOU2_CONTROL_PASSWORD || "";
  const trackerKey = process.env.TLOU2_TRACKER_KEY || "";

  let chapters = DEFAULT_CHAPTERS.map((c) => cleanChapter(c));
  let currentIndex = -1;
  let lastOcr = null;
  let db = null;
  const listeners = new Set();

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

    const result = await db.query("SELECT data FROM tlou2_state WHERE id = $1", ["primary"]);
    const saved = result.rows[0]?.data;
    if (saved && Array.isArray(saved.chapters) && saved.chapters.length) {
      chapters = saved.chapters.map((c) => cleanChapter(c));
      currentIndex = Number.isInteger(saved.currentIndex) ? saved.currentIndex : -1;
    } else {
      await persist();
    }
  }

  async function persist() {
    if (!db) return;
    await db.query(
      `INSERT INTO tlou2_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      ["primary", JSON.stringify({ chapters, currentIndex })]
    );
  }

  function payload() {
    const completed = Math.max(0, currentIndex);
    const total = chapters.length;
    return {
      chapters,
      currentIndex,
      current: currentIndex >= 0 ? chapters[currentIndex] : null,
      progress: { completed, total },
      percent: total ? Math.round((completed / total) * 1000) / 10 : 0,
      lastOcr,
      passwordRequired: Boolean(controlPassword),
      trackerConfigured: Boolean(trackerKey),
      updatedAt: new Date().toISOString()
    };
  }

  function broadcast() {
    const message = `data: ${JSON.stringify(payload())}\n\n`;
    for (const response of listeners) response.write(message);
  }

  async function commit() {
    await persist();
    broadcast();
  }

  router.use(express.json({ limit: "32kb" }));

  router.get("/api/state", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(payload());
  });

  router.get("/api/events", (request, response) => {
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

  // Called by the local OCR tracker script with raw recognized text.
  router.post("/api/tracker", async (request, response, next) => {
    try {
      if (!authorizedTracker(request)) {
        return response.status(401).json({ error: "Unauthorized" });
      }
      const text = typeof request.body?.text === "string" ? request.body.text.slice(0, 500) : "";
      if (!text) return response.status(400).json({ error: "text is required" });

      const ocrNormalized = normalize(text);
      const rangeStart = Math.max(0, currentIndex);
      const rangeEnd = Math.min(chapters.length - 1, currentIndex + LOOKAHEAD);

      let bestIndex = -1;
      let bestScore = 0;
      for (let i = rangeStart; i <= rangeEnd; i++) {
        const score = scoreMatch(ocrNormalized, matchText(chapters[i]));
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      const matched = bestScore >= MATCH_THRESHOLD;
      lastOcr = { text, matched, atISO: new Date().toISOString() };

      if (matched && bestIndex !== currentIndex) {
        currentIndex = bestIndex;
        await commit();
      } else {
        broadcast();
      }

      response.json({
        ok: true,
        matched,
        matchedChapter: matched ? chapters[bestIndex] : null,
        progress: { completed: Math.max(0, currentIndex), total: chapters.length }
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/current", requireControlAuth, async (request, response, next) => {
    try {
      const index = Number(request.body?.index);
      if (!Number.isInteger(index) || index < -1 || index >= chapters.length) {
        return response.status(400).json({ error: "index er ugyldigt." });
      }
      currentIndex = index;
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/chapters", requireControlAuth, async (request, response, next) => {
    try {
      const list = Array.isArray(request.body?.chapters) ? request.body.chapters : null;
      if (!list || !list.length) return response.status(400).json({ error: "chapters skal være en ikke-tom liste." });
      chapters = list.map((c) => cleanChapter(c));
      if (currentIndex >= chapters.length) currentIndex = chapters.length - 1;
      await commit();
      response.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/reset", requireControlAuth, async (_request, response, next) => {
    try {
      currentIndex = -1;
      lastOcr = null;
      await commit();
      response.json(payload());
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
