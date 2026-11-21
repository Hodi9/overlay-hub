import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

delete process.env.GTA6_CONTROL_PASSWORD;

const { DEFAULT_MISSIONS, isPlaceholderList } = await import("../apps/gta6/missions.js");
const { createGta6App } = await import("../apps/gta6/app.js");

test("the GTA VI list has 91 missions in five chapters, all short enough for the overlay", () => {
  assert.equal(DEFAULT_MISSIONS.length, 91);
  const perChapter = {};
  for (const m of DEFAULT_MISSIONS) perChapter[m.location] = (perChapter[m.location] || 0) + 1;
  assert.deepEqual(Object.values(perChapter), [22, 11, 26, 25, 7]);
  assert.equal(DEFAULT_MISSIONS[0].day, "Prologue");
  assert.equal(DEFAULT_MISSIONS.at(-1).location, "Chapter 5: Top of the World, Ma");
  assert.ok(DEFAULT_MISSIONS.every((m) => m.day.length <= 60 && m.location.length <= 60));
});

test("only the old Mission N / Chapter N placeholder list counts as stale", () => {
  assert.equal(isPlaceholderList([{ day: "Mission 1", location: "Chapter 1" }, { day: "Mission 2", location: "Chapter 1" }]), true);
  assert.equal(isPlaceholderList([{ day: "Mission 1", location: "Chapter 1" }, { day: "Gone Fishing", location: "Chapter 1" }]), false);
  assert.equal(isPlaceholderList(DEFAULT_MISSIONS), false);
  assert.equal(isPlaceholderList([]), false);
});

async function withApp(options, run) {
  const app = express();
  app.use("/gta6", createGta6App(options));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/gta6/api`;
  const call = async (method, path, body) => {
    const r = await fetch(`${base}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    return await run(call);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const savedPool = (data) => ({ query: async (sql) => (/^\s*SELECT/i.test(sql) ? { rows: [{ data }] } : { rows: [] }) });

test("a saved placeholder list is replaced by the real missions; a real saved list and its ticks are kept", async () => {
  const placeholder = Array.from({ length: 100 }, (_, i) => ({ day: `Mission ${i + 1}`, location: `Chapter ${Math.floor(i / 20) + 1}` }));
  const swapped = await withApp({ pool: savedPool({ chapters: placeholder, currentIndex: -1 }) }, async (call) => (await call("GET", "state")).body);
  assert.equal(swapped.chapters.length, 91);
  assert.equal(swapped.chapters[0].day, "Prologue");
  assert.equal(swapped.progress.completed, 0);

  const own = [{ id: "a", day: "Gone Fishing", location: "Chapter 1: Just Like Paradise" }, { id: "b", day: "Gear Up", location: "Chapter 1: Just Like Paradise" }];
  const kept = await withApp({ pool: savedPool({ chapters: own, currentIndex: 0, done: ["b", "gone-from-list"] }) }, async (call) => (await call("GET", "state")).body);
  assert.deepEqual(kept.chapters.map((c) => c.day), ["Gone Fishing", "Gear Up"]);
  assert.deepEqual([kept.progress.completed, kept.done, kept.current.day], [1, ["b"], "Gone Fishing"]);
});

test("GTA VI missions are ticked off in any order; playing now moves on to the next open one", async () => {
  await withApp({}, async (call) => {
    let s = (await call("GET", "state")).body;
    assert.deepEqual([s.nonLinear, s.started, s.progress.completed, s.progress.total], [true, false, 0, 91]);
    const id = (i) => s.chapters[i].id;

    // Play mission 3 first, then tick off 3 and 1 (mission 2 is skipped for now).
    s = (await call("PATCH", "current", { index: 2 })).body;
    assert.deepEqual([s.started, s.current.day, s.progress.completed], [true, "Gear Up", 0]);
    s = (await call("PATCH", "done", { id: id(2), done: true })).body;
    assert.equal(s.current.day, "Just a Scratch", "moves to the next open mission");
    s = (await call("PATCH", "done", { id: id(0), done: true })).body;
    assert.deepEqual([s.progress.completed, s.percent], [2, 2.2]);
    assert.equal(s.current.day, "Just a Scratch", "ticking another mission does not move playing now");

    // Un-tick, and a whole chapter at once.
    s = (await call("PATCH", "done", { id: id(0), done: false })).body;
    assert.equal(s.progress.completed, 1);
    s = (await call("PATCH", "done", { ids: s.chapters.slice(0, 22).map((c) => c.id), done: true })).body;
    assert.equal(s.progress.completed, 22);
    assert.equal(s.current.location, "Chapter 2: Paradise Lost");
    assert.equal((await call("PATCH", "done", { id: "nope", done: true })).status, 400);

    // Finished = every mission ticked; reset clears the ticks.
    s = (await call("PATCH", "current", { index: 91 })).body;
    assert.deepEqual([s.finished, s.progress.completed, s.current], [true, 91, null]);
    s = (await call("POST", "reset")).body;
    assert.deepEqual([s.started, s.progress.completed, s.done.length], [false, 0, 0]);
  });
});

test("a stream reader's text sets playing now, ticks the mission before it, and must come from the channel's own stream", async () => {
  const channels = {
    has: (id) => id === "marcelochan",
    authorize: (_id, request) => request.headers.authorization === "Bearer tracker-key",
    publicRecord: (id) => (id === "marcelochan" ? { id, twitch: "marcelo" } : null)
  };
  const app = express();
  app.use("/gta6", createGta6App({ channels }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/gta6/api`;
  const send = async (text, source, key = "tracker-key") => {
    const r = await fetch(`${base}/tracker?profile=marcelochan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ text, source })
    });
    return { status: r.status, body: await r.json() };
  };
  const state = async () => (await fetch(`${base}/state?profile=marcelochan`)).json();
  try {
    assert.equal((await send("Gone Fishing", "marcelo", "wrong")).status, 401);
    assert.equal((await send("Gone Fishing", "wendelbolol")).status, 409, "text from another stream is refused");

    assert.equal((await send("Gone Fishing", "marcelo")).body.matched, true);
    let s = await state();
    assert.deepEqual([s.current.day, s.progress.completed, s.lastCapture.source], ["Gone Fishing", 0, "marcelo"]);

    // Reading the mission already shown (e.g. the overlay's own text) changes nothing.
    await send("Gone Fishing", "marcelo");
    s = await state();
    assert.deepEqual([s.current.day, s.progress.completed], ["Gone Fishing", 0]);

    // A new title: Gone Fishing is ticked, Lab Fees is playing now.
    await send("Lab Fees", "marcelo");
    s = await state();
    assert.deepEqual([s.current.day, s.progress.completed], ["Lab Fees", 1]);
    assert.ok(s.done.includes(s.chapters[1].id));

    // Kill switch: switched off in the panel, everything the reader sends is refused until it is on again.
    const owner = (enabled) => fetch(`${base}/reader?profile=marcelochan`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer tracker-key" }, body: JSON.stringify({ enabled }) });
    const off = await owner(false);
    assert.equal(off.status, 200);
    assert.equal((await off.json()).readerEnabled, false);
    const refused = await send("Just a Scratch", "marcelo");
    assert.deepEqual([refused.status, refused.body.disabled], [423, true]);
    assert.equal((await state()).current.day, "Lab Fees", "nothing changed while off");
    await owner(true);
    await send("Just a Scratch", "marcelo");
    assert.equal((await state()).current.day, "Just a Scratch");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the stream reader only accepts whole mission names and skips the one playing and the ticked ones", async () => {
  const { findMission, normalize } = await import("../apps/gta6/reader/reader.mjs");
  const chapters = DEFAULT_MISSIONS.map((m, i) => ({ ...m, id: `m${i}` }));
  const none = new Set();
  assert.equal(normalize("What's in the Bag?"), "whats in the bag");
  assert.equal(findMission(["GEAR UP"], chapters, none)?.chapter.day, "Gear Up");
  assert.equal(findMission(["Whats in the Bag"], chapters, none)?.chapter.day, "What's in the Bag?");
  assert.equal(findMission(["STEAL THE ZORRUSO", "FOR RANDY"], chapters, none)?.chapter.day, "Steal the Zorrusso for Randy", "a wrapped title, one OCR slip");
  assert.equal(findMission(["UP"], chapters, none), null, "part of a name never counts");
  assert.equal(findMission(["ZOOM"], chapters, none), null);
  assert.equal(findMission(["Tyrone."], chapters, none), null, "a subtitle ending in a full stop");
  assert.equal(findMission(["tyrone"], chapters, none), null, "a subtitle cut off mid-sentence");
  assert.equal(findMission(["TYRONE"], chapters, none)?.chapter.day, "Tyrone");
  assert.equal(findMission(["Hey Arnold!"], chapters, none)?.chapter.day, "Hey Arnold!");
  assert.equal(findMission(["[Spoiler]"], chapters, none), null);
  assert.equal(findMission(["CHAPTER 1: JUST LIKE PARADISE"], chapters, none), null, "the overlay's chapter line");
  assert.equal(findMission(["GONE FISHING"], chapters, new Set(["m1"])), null, "the mission already playing (the overlay's own line)");
});

test("the three missions hidden before launch have their real names, also in a list saved back then", async () => {
  const { nameSpoilers } = await import("../apps/gta6/missions.js");
  const names = DEFAULT_MISSIONS.map((m) => m.day);
  assert.ok(!names.includes("[Spoiler]"));
  assert.deepEqual([names[17], names[83], names[90]], ["Don Gone", "Starting From Zero", "The End of the Road"]);

  const old = DEFAULT_MISSIONS.map((m, i) => ({ ...m, id: `m${i}`, day: [17, 83, 90].includes(i) ? "[Spoiler]" : m.day }));
  const loaded = await withApp({ pool: savedPool({ chapters: old, currentIndex: 18, done: ["m17", "m0"] }) }, async (call) => (await call("GET", "state")).body);
  assert.deepEqual([loaded.chapters[17].id, loaded.chapters[17].day, loaded.chapters[83].day, loaded.chapters[90].day], ["m17", "Don Gone", "Starting From Zero", "The End of the Road"]);
  assert.deepEqual([loaded.progress.completed, loaded.current.day], [2, "Recalibration"], "ticks and playing now are kept");
  assert.equal(nameSpoilers(DEFAULT_MISSIONS), null, "nothing to rename in the current list");
});

test("a reader's hint is only a suggestion in the panel: it moves nothing, can be dismissed, and goes away once played", async () => {
  await withApp({}, async (call) => {
    let s = (await call("GET", "state")).body;
    const party = s.chapters.find((c) => c.day === "Party Hard");
    s = (await call("PATCH", "current", { index: s.chapters.findIndex((c) => c.day === "Lawyer Up") })).body;
    assert.equal(s.hint, null);
    assert.equal((await call("POST", "hint", { id: party.id, keyword: "Megamundo" })).status, 401, "needs the tracker key");
  });

  process.env.GTA6_TRACKER_KEY = "reader-key";
  try {
    const app = express();
    app.use("/gta6", createGta6App({}));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/gta6/api`;
    const req = async (method, path, body, key) => {
      const r = await fetch(`${base}/${path}`, { method, headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    try {
      let s = (await req("GET", "state")).body;
      const party = s.chapters.find((c) => c.day === "Party Hard");
      const lawyer = s.chapters.findIndex((c) => c.day === "Lawyer Up");
      await req("PATCH", "current", { index: lawyer });
      assert.equal((await req("POST", "hint", { id: "nope", keyword: "x" }, "reader-key")).status, 400);
      const sent = await req("POST", "hint", { id: party.id, keyword: "Megamundo" }, "reader-key");
      assert.equal(sent.status, 200);
      s = (await req("GET", "state")).body;
      assert.deepEqual([s.hint.day, s.hint.keyword, s.current.day, s.progress.completed], ["Party Hard", "Megamundo", "Lawyer Up", 0], "nothing moved");
      s = (await req("DELETE", "hint")).body;
      assert.equal(s.hint, null, "dismissed");
      await req("POST", "hint", { id: party.id, keyword: "Megamundo" }, "reader-key");
      s = (await req("PATCH", "current", { index: s.chapters.indexOf(s.chapters.find((c) => c.id === party.id)) })).body;
      assert.deepEqual([s.current.day, s.hint], ["Party Hard", null], "confirmed: playing now, hint gone");
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    delete process.env.GTA6_TRACKER_KEY;
  }
});

test("the reader reads the pause menu only with a bare CHAPTER line, keeps unknown titles and makes careful hints", async () => {
  const { findMenuMission, looksLikeTitle, compileHints, findHint } = await import("../apps/gta6/reader/reader.mjs");
  const chapters = DEFAULT_MISSIONS.map((m, i) => ({ ...m, id: `m${i}` }));
  const none = new Set();

  // Pause menu: "CHAPTER 4", the mission, "Last Checkpoint" — with the overlay's death counter in the way.
  assert.equal(findMenuMission(["CHAPTER 4", "24 Deaths", "HEAVY LIFTING", "Last Checkpoint"], chapters, none).chapter.day, "Heavy Lifting");
  // The streamer's overlay says "CHAPTER 4: VICE CITY, BABY" with a colon: never taken for the menu.
  assert.equal(findMenuMission(["CHAPTER 4: VICE CITY, BABY", "HEAVY LIFTING"], chapters, none), null);
  // Only missions of the chapter shown count.
  assert.equal(findMenuMission(["CHAPTER 3", "HEAVY LIFTING"], chapters, none), null);
  assert.equal(findMenuMission(["CHAPTER 4", "HEAVY LIFTING"], chapters, new Set(["m64"])), null, "playing or ticked off: skipped");

  // Unknown titles: capitals like a title card, not a button prompt or a number.
  assert.equal(looksLikeTitle("CLIMBING THE FOOD CHAIN"), true);
  assert.equal(looksLikeTitle("DON GONE"), true);
  for (const ui of ["HOLD HANDS", "SET DESTINATION", "STAFF MEMBER", "PHOTO STUDIO @ SELECT BACK", "1833/1850", "Yo, ask security", "PIGS"]) {
    assert.equal(looksLikeTitle(ui), false, ui);
  }

  // Hints: a whole word, a mission not playing or ticked, and only in the chapter being played.
  const hints = compileHints({ "Party Hard": ["Megamundo"], "Cash Injections": ["Synthol"], "Bird in the Hand": ["Mile Zero Air Station"] });
  const ch4 = "Chapter 4: Vice City, Baby";
  assert.equal(findHint(["Valentina | We need you at the Megamundo opening."], hints, chapters, none, ch4).chapter.day, "Party Hard");
  assert.equal(findHint(["MEGAMUNDOS"], hints, chapters, none, ch4), null, "part of a word does not count");
  assert.equal(findHint(["Head to Mile Zero Air Station"], hints, chapters, none, ch4), null, "chapter 5 mission while playing chapter 4");
  assert.equal(findHint(["Synthol"], hints, chapters, new Set(["m68"]), ch4), null, "already ticked off");
  assert.equal(findHint(["Megamundo"], hints, chapters, none, null), null, "no mission playing: no guess");
});
