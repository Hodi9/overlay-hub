import express from "express";
import { parseFeed } from "./feed.js";

const DEFAULT_USER = "dreamglowxd";
const TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 8000;

/**
 * GET /diary → { films, fetchedAt, stale }. Henter brugerens offentlige Letterboxd-feed og gemmer svaret
 * i hukommelsen i en halv time, så forsiden ikke spørger Letterboxd ved hvert besøg. Hvis Letterboxd er nede,
 * vises det sidste svar (stale: true); har vi aldrig fået et, svarer vi 502.
 *
 * Env: LETTERBOXD_USER (standard dreamglowxd), LETTERBOXD_FEED_URL (kun til test: peger på en anden feed).
 */
export function createLetterboxdApp({
  user = process.env.LETTERBOXD_USER || DEFAULT_USER,
  feedUrl = process.env.LETTERBOXD_FEED_URL || "",
  ttlMs = TTL_MS,
  fetchImpl = fetch,
  now = () => Date.now()
} = {}) {
  const router = express.Router();
  const cleanUser = /^[A-Za-z0-9_]{1,40}$/.test(user) ? user : DEFAULT_USER;
  const url = feedUrl || `https://letterboxd.com/${cleanUser}/rss/`;

  let cached = null; // { films, fetchedAt }
  let inFlight = null;

  async function load() {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": "dreamglow-site/1.0 (+https://dreamglow.xyz)", Accept: "application/rss+xml, application/xml" },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Letterboxd svarede ${response.status}`);
    const films = parseFeed(await response.text());
    cached = { films, fetchedAt: now() };
    return cached;
  }

  router.get("/diary", async (_request, response) => {
    response.set("Cache-Control", "public, max-age=300");
    const fresh = cached && now() - cached.fetchedAt < ttlMs;
    if (fresh) return response.json({ films: cached.films, fetchedAt: new Date(cached.fetchedAt).toISOString(), stale: false });

    try {
      inFlight = inFlight || load().finally(() => { inFlight = null; });
      const result = await inFlight;
      return response.json({ films: result.films, fetchedAt: new Date(result.fetchedAt).toISOString(), stale: false });
    } catch (error) {
      console.error("letterboxd: kunne ikke hente feedet.", error.message);
      if (cached) return response.json({ films: cached.films, fetchedAt: new Date(cached.fetchedAt).toISOString(), stale: true });
      return response.status(502).json({ error: "Kunne ikke hente Letterboxd lige nu." });
    }
  });

  return router;
}
