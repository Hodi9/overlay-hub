import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

delete process.env.LIVETIMER_CONTROL_PASSWORD;
delete process.env.LIVETIMER_CHANNEL;

const { DEFAULT_STATE, LOG_LIMIT, adjust, applyStatus, cleanChannel, elapsedMs, parseDecapiUptime, parseDuration, recordError, reset, restore, setElapsed, setEnabled } = await import("../apps/livetimer/logic.js");
const { createStatusChecker } = await import("../apps/livetimer/twitchStatus.js");
const { createLiveTimerApp } = await import("../apps/livetimer/app.js");

const T0 = Date.parse("2026-11-18T18:00:00Z");
const min = (n) => n * 60000;
const at = (n) => T0 + min(n);
const live = (startedMin) => ({ live: true, startedAt: new Date(at(startedMin)).toISOString() });
const OFF = { live: false, startedAt: null };

test("decapi's uptime text becomes milliseconds, OFFLINE becomes null, anything else throws", () => {
  assert.equal(parseDecapiUptime("OFFLINE"), null);
  assert.equal(parseDecapiUptime("wendelbolol is offline"), null);
  assert.equal(parseDecapiUptime("1 day, 2 hours, 5 minutes, 3 seconds"), 86400000 + 2 * 3600000 + 5 * 60000 + 3000);
  assert.equal(parseDecapiUptime("1 hour, 1 minute"), 3660000);
  assert.equal(parseDecapiUptime("0 seconds"), 0);
  assert.throws(() => parseDecapiUptime("User not found: nobody"));
  assert.throws(() => parseDecapiUptime(""));
});

test("channel names are cleaned from links and checked", () => {
  assert.equal(cleanChannel("https://www.twitch.tv/WendelboLOL"), "wendelbolol");
  assert.equal(cleanChannel("@wendelbolol"), "wendelbolol");
  assert.equal(cleanChannel("twitch.tv/wendelbolol/videos?x=1"), "wendelbolol");
  assert.equal(cleanChannel("not a name"), null);
});

test("runs from the stream's start while live, stops at the last live check when it goes offline", () => {
  let s = restore({});
  s = applyStatus(s, OFF, at(0));
  assert.equal(elapsedMs(s, at(0)), 0);
  s = applyStatus(s, live(1), at(2)); // went live at minute 1, seen at minute 2
  assert.equal(elapsedMs(s, at(2)), min(1));
  s = applyStatus(s, live(1), at(60));
  s = applyStatus(s, OFF, at(61)); // ended somewhere between 60 and 61: counts until 60
  assert.equal(s.liveSince, null);
  assert.equal(elapsedMs(s, at(500)), min(59));
});

test("a new stream later adds to the total; a stream that flickers offline is not counted twice", () => {
  let s = restore({});
  s = applyStatus(s, live(0), at(0));
  s = applyStatus(s, live(0), at(30));
  s = applyStatus(s, OFF, at(31)); // 30 min counted
  // Same stream back (Twitch hiccup): start time is still minute 0, but counting resumes at 30, not 0.
  s = applyStatus(s, live(0), at(32));
  assert.equal(elapsedMs(s, at(32)), min(32));
  s = applyStatus(s, live(0), at(40));
  s = applyStatus(s, OFF, at(41));
  // Next day, a new stream.
  s = applyStatus(s, live(1440), at(1441));
  assert.equal(elapsedMs(s, at(1441)), min(41));
});

test("a failed check changes nothing but the error", () => {
  let s = applyStatus(restore({}), live(0), at(5));
  const failed = recordError(s, "decapi svarede 503.", at(6));
  assert.equal(failed.liveSince, s.liveSince);
  assert.equal(failed.lastError, "decapi svarede 503.");
  assert.equal(applyStatus(failed, live(0), at(7)).lastError, null);
});

test("reset goes to 0 and keeps running if live; reset while offline ignores the old stream's start", () => {
  let s = applyStatus(restore({}), live(0), at(10));
  s = reset(s, at(10));
  assert.equal(elapsedMs(s, at(15)), min(5));
  let off = applyStatus(applyStatus(restore({}), live(0), at(10)), OFF, at(11));
  off = reset(off, at(20));
  assert.equal(elapsedMs(off, at(20)), 0);
  // If the check after the reset still reports a stream that began before it, counting starts at the reset.
  off = applyStatus(off, live(15), at(25));
  assert.equal(elapsedMs(off, at(25)), min(5));
});

test("turning automatic off pauses even while live; on again resumes from that moment", () => {
  let s = applyStatus(restore({}), live(0), at(10));
  s = setEnabled(s, false, at(10));
  s = applyStatus(s, live(0), at(20));
  assert.equal(elapsedMs(s, at(20)), min(10));
  assert.equal(s.live, true);
  s = setEnabled(s, true, at(20));
  s = applyStatus(s, live(0), at(21));
  assert.equal(elapsedMs(s, at(21)), min(11));
});

test("restore falls back to safe defaults", () => {
  const s = restore({ channel: "!!", accumulatedMs: -5, accent: "neon", enabled: "x" });
  assert.deepEqual([s.channel, s.accumulatedMs, s.accent, s.enabled], [DEFAULT_STATE.channel, 0, "lime", true]);
});

test("typed times are read as t:mm:ss, h:mm or days + t:mm:ss", () => {
  assert.equal(parseDuration("1:02:03"), 3723000);
  assert.equal(parseDuration(" 30:00:00 "), 30 * 3600000);
  assert.equal(parseDuration("12:30"), 12 * 3600000 + 30 * 60000);
  assert.equal(parseDuration("2d 3:04:05"), (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000);
  assert.equal(parseDuration("1 dag 0:00:00"), 86400000);
  assert.equal(parseDuration("1:60:00"), null);
  assert.equal(parseDuration("abc"), null);
  assert.equal(parseDuration(""), null);
});

test("a correction sets the time; a running timer keeps running from it; nudges never go below 0", () => {
  let s = applyStatus(restore({}), live(0), at(10)); // running, 10 min
  s = setElapsed(s, 3600000, at(10));
  assert.equal(elapsedMs(s, at(15)), 3600000 + min(5));
  s = adjust(s, -min(10), at(15));
  assert.equal(elapsedMs(s, at(15)), 3600000 - min(5));
  let off = setElapsed(restore({}), min(3), at(0));
  off = adjust(off, -min(10), at(1));
  assert.equal(elapsedMs(off, at(99)), 0);
  assert.equal(off.liveSince, null);
});

test("the log records starts, stops, pauses, resets and corrections with the time shown then", () => {
  let s = restore({});
  s = applyStatus(s, live(0), at(1));
  s = applyStatus(s, live(0), at(60));
  s = applyStatus(s, OFF, at(61));
  s = setEnabled(s, false, at(70));
  s = setEnabled(s, true, at(71));
  s = setElapsed(s, min(90), at(72));
  s = reset(s, at(73));
  assert.deepEqual(s.log.map((e) => e.type), ["reset", "correct", "auto-on", "auto-off", "stop", "start"]);
  const [r, c, , , stop, start] = s.log;
  assert.equal(start.elapsedMs, 0);
  assert.equal(stop.elapsedMs, min(60));
  assert.equal(stop.at, new Date(at(60)).toISOString());
  assert.equal(stop.channel, "wendelbolol");
  assert.deepEqual([c.fromMs, c.elapsedMs], [min(60), min(90)]);
  assert.deepEqual([r.fromMs, r.elapsedMs], [min(90), 0]);
  for (let i = 0; i < LOG_LIMIT + 5; i++) s = adjust(s, 1000, at(80));
  assert.equal(s.log.length, LOG_LIMIT);
  assert.equal(restore({ log: [{ type: "stop", at: "x", elapsedMs: 1 }, null, { type: "stop", at: new Date(T0).toISOString(), elapsedMs: 5 }] }).log.length, 1);
});

test("the status checker reads decapi without keys and Helix with keys", async () => {
  const decapi = createStatusChecker({ clientId: "", clientSecret: "", fetchImpl: async (url) => {
    assert.match(String(url), /^https:\/\/decapi\.me\/twitch\/uptime\/wendelbolol\?/);
    return new Response("2 hours, 3 minutes");
  } });
  const before = Date.now();
  const status = await decapi.check("wendelbolol");
  assert.equal(status.live, true);
  assert.ok(Math.abs(before - Date.parse(status.startedAt) - (2 * 3600000 + 3 * 60000)) < 2000);

  const calls = [];
  const helix = createStatusChecker({ clientId: "id", clientSecret: "secret", fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://id.twitch.tv/")) return Response.json({ access_token: "tok", expires_in: 3600 });
    return Response.json({ data: [{ type: "live", started_at: "2026-11-18T18:00:00Z" }] });
  } });
  assert.deepEqual(await helix.check("wendelbolol"), { live: true, startedAt: "2026-11-18T18:00:00Z", source: "twitch" });
  assert.equal(calls.length, 2);
});

test("the app follows checks, and the panel can change channel, pause and reset", async () => {
  let clock = at(0);
  let status = OFF;
  const seen = [];
  const router = createLiveTimerApp({ pollMs: 0, now: () => clock, checkStatus: async (channel) => { seen.push(channel); return status; } });
  const app = express();
  app.use("/livetimer", router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/livetimer/api`;
  const call = (method, path, body) => fetch(`${base}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());
  try {
    assert.equal((await call("GET", "state")).channel, "wendelbolol");
    status = live(0);
    clock = at(3);
    let s = await call("POST", "check");
    assert.equal(s.live, true);
    assert.equal(s.liveSince, new Date(at(0)).toISOString());
    clock = at(10);
    s = await call("PATCH", "settings", { enabled: false });
    assert.equal(s.accumulatedMs, min(10));
    assert.equal(s.liveSince, null);
    s = await call("PATCH", "settings", { channel: "https://twitch.tv/SomeoneElse" });
    assert.equal(s.channel, "someoneelse");
    assert.equal(seen.at(-1), "someoneelse");
    assert.match((await fetch(`${base}/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: "x y" }) })).status.toString(), /400/);
    s = await call("POST", "reset");
    assert.equal(s.accumulatedMs, 0);
    s = await call("POST", "correct", { time: "12:34:56" });
    assert.equal(s.accumulatedMs, (12 * 3600 + 34 * 60 + 56) * 1000);
    s = await call("POST", "correct", { deltaMs: -60000 });
    assert.equal(s.accumulatedMs, (12 * 3600 + 33 * 60 + 56) * 1000);
    s = await call("POST", "correct", { elapsedMs: 5000 });
    assert.equal(s.accumulatedMs, 5000);
    assert.equal(s.log[0].type, "correct");
    assert.ok(s.log.some((e) => e.type === "channel" && e.channel === "someoneelse"));
    const bad = await fetch(`${base}/correct`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ time: "nope" }) });
    assert.equal(bad.status, 400);
    s = await call("PATCH", "settings", { label: "Stream time", accent: "pink" });
    assert.deepEqual([s.label, s.accent], ["Stream time", "pink"]);
  } finally {
    router.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
