import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { parseFeed, starsToScore } from "../apps/letterboxd/feed.js";
import { createLetterboxdApp } from "../apps/letterboxd/app.js";

const item = (fields) => `<item> <title>x</title> ${fields} </item>`;

// Samme opbygning som det rigtige feed (første indlæg er kopieret derfra).
const FEED = `<?xml version='1.0' encoding='utf-8'?>
<rss version="2.0" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org"><channel>
${item(`<link>https://letterboxd.com/dreamglowxd/film/hacksaw-ridge/</link> <guid isPermaLink="false">letterboxd-review-1556346091</guid>
  <letterboxd:watchedDate>2026-10-26</letterboxd:watchedDate> <letterboxd:rewatch>Yes</letterboxd:rewatch>
  <letterboxd:filmTitle>Hacksaw Ridge</letterboxd:filmTitle> <letterboxd:filmYear>2016</letterboxd:filmYear>
  <letterboxd:memberRating>4.5</letterboxd:memberRating> <letterboxd:memberLike>Yes</letterboxd:memberLike> <tmdb:movieId>324786</tmdb:movieId>
  <description><![CDATA[ <p><img src="https://a.ltrbxd.com/resized/film-poster/2/5/1/8/7/2/251872-hacksaw-ridge-0-600-0-900-crop.jpg?v=031e346657"/></p> <p>Incredible movie</p> ]]></description>`)}
${item(`<link>https://letterboxd.com/dreamglowxd/film/tom-jerry/</link> <guid isPermaLink="false">letterboxd-watch-2</guid>
  <letterboxd:watchedDate>2026-10-28</letterboxd:watchedDate> <letterboxd:rewatch>No</letterboxd:rewatch>
  <letterboxd:filmTitle>Fast &amp; Furious</letterboxd:filmTitle> <letterboxd:filmYear>2009</letterboxd:filmYear>
  <letterboxd:memberRating>3.5</letterboxd:memberRating>
  <description><![CDATA[ <p><img src="https://a.ltrbxd.com/p2.jpg"/></p> <p>Watched on Wednesday October 28, 2026.</p> ]]></description>`)}
${item(`<link>https://letterboxd.com/dreamglowxd/film/uden-rating/</link> <guid isPermaLink="false">letterboxd-watch-3</guid>
  <letterboxd:watchedDate>2026-10-20</letterboxd:watchedDate> <letterboxd:rewatch>No</letterboxd:rewatch>
  <letterboxd:filmTitle>Uden rating</letterboxd:filmTitle> <letterboxd:filmYear>1999</letterboxd:filmYear>
  <description><![CDATA[ <p>Første linje.<br/>Anden linje.</p> <p>Nyt afsnit.</p> ]]></description>`)}
${item(`<link>https://letterboxd.com/dreamglowxd/list/favoritter/</link> <guid>letterboxd-list-1</guid> <description>En liste, ikke en film</description>`)}
</channel></rss>`;

test("starsToScore ganger med to og afviser det, der ikke er en rating", () => {
  assert.equal(starsToScore(4.5), 9);
  assert.equal(starsToScore(0.5), 1);
  assert.equal(starsToScore(5), 10);
  assert.equal(starsToScore(0), null);
  assert.equal(starsToScore(NaN), null);
  assert.equal(starsToScore(6), null);
});

test("parseFeed læser film, rating, år, plakat, note og datoer", () => {
  const films = parseFeed(FEED);
  const hacksaw = films.find((f) => f.title === "Hacksaw Ridge");
  assert.deepEqual(
    { year: hacksaw.year, stars: hacksaw.stars, score: hacksaw.score, liked: hacksaw.liked, rewatch: hacksaw.rewatch, watchedDate: hacksaw.watchedDate },
    { year: 2016, stars: 4.5, score: 9, liked: true, rewatch: true, watchedDate: "2026-10-26" }
  );
  assert.equal(hacksaw.url, "https://letterboxd.com/dreamglowxd/film/hacksaw-ridge/");
  assert.match(hacksaw.poster, /^https:\/\/a\.ltrbxd\.com\/.*hacksaw-ridge/);
  assert.equal(hacksaw.note, "Incredible movie");
});

test("parseFeed springer indlæg uden film over og afkoder tegn", () => {
  const films = parseFeed(FEED);
  assert.equal(films.length, 3);
  assert.ok(films.some((f) => f.title === "Fast & Furious"));
});

test("Letterboxds standardtekst 'Watched on …' tæller ikke som en note", () => {
  const furious = parseFeed(FEED).find((f) => f.title === "Fast & Furious");
  assert.equal(furious.note, "");
});

test("parseFeed sorterer nyeste først efter den dag, filmen blev set", () => {
  assert.deepEqual(parseFeed(FEED).map((f) => f.watchedDate), ["2026-10-28", "2026-10-26", "2026-10-20"]);
});

test("en film uden rating får score null, og noten bevarer linjeskift", () => {
  const unrated = parseFeed(FEED).find((f) => f.title === "Uden rating");
  assert.equal(unrated.score, null);
  assert.equal(unrated.stars, null);
  assert.equal(unrated.poster, null);
  assert.equal(unrated.note, "Første linje.\nAnden linje.\n\nNyt afsnit.");
});

test("parseFeed tåler tomt eller ødelagt input", () => {
  assert.deepEqual(parseFeed(""), []);
  assert.deepEqual(parseFeed(null), []);
  assert.deepEqual(parseFeed("<html>not a feed</html>"), []);
});

async function withRoute(options, fn) {
  const app = express();
  app.use("/api/letterboxd", createLetterboxdApp(options));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/letterboxd`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const okResponse = (body) => ({ ok: true, status: 200, text: async () => body });

test("ruten gemmer feedet, så Letterboxd kun spørges én gang pr. periode", async () => {
  let calls = 0;
  let clock = 1_000_000;
  const fetchImpl = async () => { calls++; return okResponse(FEED); };
  await withRoute({ fetchImpl, now: () => clock, ttlMs: 60_000 }, async (base) => {
    const first = await fetch(`${base}/diary`).then((r) => r.json());
    await fetch(`${base}/diary`);
    assert.equal(calls, 1);
    assert.equal(first.films.length, 3);
    assert.equal(first.stale, false);

    clock += 61_000;
    await fetch(`${base}/diary`);
    assert.equal(calls, 2);
  });
});

test("flere samtidige besøg deler ét kald til Letterboxd", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return okResponse(FEED); };
  await withRoute({ fetchImpl }, async (base) => {
    await Promise.all([1, 2, 3, 4].map(() => fetch(`${base}/diary`).then((r) => r.json())));
    assert.equal(calls, 1);
  });
});

test("er Letterboxd nede, vises det sidste svar markeret som gammelt", async () => {
  let fail = false;
  let clock = 0;
  const fetchImpl = async () => (fail ? { ok: false, status: 503, text: async () => "" } : okResponse(FEED));
  await withRoute({ fetchImpl, now: () => clock, ttlMs: 1000 }, async (base) => {
    await fetch(`${base}/diary`);
    fail = true;
    clock += 5000;
    const response = await fetch(`${base}/diary`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.stale, true);
    assert.equal(body.films.length, 3);
  });
});

test("har vi aldrig fået feedet, svarer ruten 502 med en tekst", async () => {
  const fetchImpl = async () => { throw new Error("netværk nede"); };
  await withRoute({ fetchImpl }, async (base) => {
    const response = await fetch(`${base}/diary`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /Letterboxd/);
  });
});

test("brugernavnet bliver kun brugt, hvis det ser rigtigt ud", async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return okResponse(FEED); };
  await withRoute({ fetchImpl, user: "../etc/passwd" }, async (base) => { await fetch(`${base}/diary`); });
  await withRoute({ fetchImpl, user: "min_bruger1" }, async (base) => { await fetch(`${base}/diary`); });
  assert.equal(urls[0], "https://letterboxd.com/dreamglowxd/rss/");
  assert.equal(urls[1], "https://letterboxd.com/min_bruger1/rss/");
});
