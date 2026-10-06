import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, aggregateEmotes, aggregateEvents, parseWhen, dayKey } from "../apps/subathon/stats.js";
import { createCollector, extractEmotes, parseList } from "../apps/subathon/collector.js";
import { createSevenTv } from "../apps/subathon/sevenTv.js";
import { createWatchtime } from "../apps/subathon/watch.js";

const TZ = "Europe/Copenhagen";
const H = 3600_000;

test("parseWhen reads dates in the configured time zone", () => {
  assert.equal(new Date(parseWhen("2026-07-01", TZ)).toISOString(), "2026-06-30T22:00:00.000Z"); // CEST = UTC+2
  assert.equal(new Date(parseWhen("2026-01-01", TZ)).toISOString(), "2025-12-31T23:00:00.000Z"); // CET = UTC+1
  assert.equal(new Date(parseWhen("2026-07-01", TZ, { end: true })).toISOString(), "2026-07-01T22:00:00.000Z");
  assert.equal(new Date(parseWhen("2026-07-01T18:30", TZ)).toISOString(), "2026-07-01T16:30:00.000Z");
  assert.equal(parseWhen("nonsense", TZ), null);
  assert.equal(parseWhen("", TZ), null);
});

test("aggregate ranks users, filters the range and counts days, hours and streaks", () => {
  const t0 = Date.UTC(2026, 6, 1, 10); // 12:00 Copenhagen
  const row = (hour, username, messages) => ({ hour, username, display: username, messages, words: messages * 3, chars: messages * 10, emotes: 1 });
  const rows = [
    row(t0, "alice", 10), row(t0 + H, "alice", 5), row(t0 + 24 * H, "alice", 1), row(t0 + 48 * H, "alice", 1),
    row(t0, "bob", 20),
    row(t0 + 100 * H, "carol", 99) // outside range below
  ];
  const out = aggregate(rows, { fromMs: t0, toMs: t0 + 72 * H, tz: TZ });
  assert.deepEqual(out.chatters.map((c) => c.username), ["alice", "bob"]);
  const alice = out.chatters[0];
  assert.equal(alice.messages, 17);
  assert.equal(alice.activeHours, 4);
  assert.equal(alice.activeDays, 3);
  assert.equal(alice.streak, 3);
  assert.equal(alice.score, 17 + 4 * 5);
  assert.equal(out.totals.messages, 37);
  assert.equal(out.totals.chatters, 2);
  assert.equal(out.timeline.unit, "hour");
  assert.ok(out.timeline.points.some((p) => p.messages === 0), "gaps are filled with zeros");
  assert.equal(dayKey(t0, TZ), "2026-07-01");
});

test("mods and VIPs are split into their own bracket by their latest role", () => {
  const t0 = Date.UTC(2026, 6, 1, 10);
  const row = (hour, username, role, messages) => ({ hour, username, display: username, role, messages, words: messages, chars: messages, emotes: 0 });
  const out = aggregate([
    row(t0, "viewer", "", 50), row(t0, "modder", "mod", 500), row(t0, "vippy", "vip", 100),
    row(t0, "promoted", "", 10), row(t0 + H, "promoted", "vip", 10)
  ], { fromMs: t0, toMs: t0 + 5 * H, tz: TZ });
  assert.deepEqual(out.chatters.map((c) => c.username), ["viewer"]);
  assert.deepEqual(out.staff.map((c) => c.username), ["modder", "vippy", "promoted"]);
  assert.equal(out.totals.chatters, 1);
  assert.equal(out.totals.staff, 3);
  assert.equal(out.totals.messages, 670);
});

test("collector records badges and honours the forced staff list", () => {
  const c = createCollector({ channel: "streamer", staff: ["friend"] });
  const at = Date.UTC(2026, 6, 1, 10);
  c.record({ username: "a", text: "hi", role: "mod", at });
  c.record({ username: "friend", text: "hi", at });
  const roles = Object.fromEntries(c.drain().chat.map((r) => [r.username, r.role]));
  assert.deepEqual(roles, { a: "mod", friend: "mod" });
});

test("collector skips bots, the streamer, commands and repeated spam", () => {
  const c = createCollector({ channel: "streamer", exclude: parseList("@MyBot") });
  const at = Date.UTC(2026, 6, 1, 10, 0, 0);
  assert.equal(c.record({ username: "Nightbot", text: "hi", at }), false);
  assert.equal(c.record({ username: "streamer", text: "hi", at }), false);
  assert.equal(c.record({ username: "mybot", text: "hi", at }), false);
  assert.equal(c.record({ username: "fan", text: "!uptime", at }), false);
  assert.equal(c.record({ username: "fan", display: "Fan", text: "hello there", emotes: 2, at }), true);
  assert.equal(c.record({ username: "fan", text: "hello there", at: at + 3000 }), false); // duplicate within 10s
  assert.equal(c.record({ username: "fan", text: "hello there", at: at + 20_000 }), true);
  const [row] = c.drain().chat;
  assert.equal(row.messages, 2);
  assert.equal(row.words, 4);
  assert.equal(row.emotes, 2);
  assert.equal(row.display, "Fan");
  assert.equal(c.drain().chat.length, 0);
});

test("emote names are cut out by code point, even after emoji", () => {
  assert.deepEqual(extractEmotes("Kappa hi Kappa", { 25: ["0-4", "9-13"] }), [{ id: "25", name: "Kappa" }, { id: "25", name: "Kappa" }]);
  assert.deepEqual(extractEmotes("😀 LUL", { 425618: ["2-4"] }), [{ id: "425618", name: "LUL" }]);
  assert.deepEqual(extractEmotes("no emotes", null), []);
});

test("collector only records inside the subathon window and counts emotes", () => {
  const startMs = Date.UTC(2026, 9, 11, 13), endMs = Date.UTC(2026, 9, 25, 20);
  const c = createCollector({ channel: "streamer", window: { startMs, endMs } });
  assert.equal(c.record({ username: "a", text: "too early", at: startMs - 1 }), false);
  assert.equal(c.record({ username: "a", text: "Kappa", emoteList: [{ id: "25", name: "Kappa" }], at: startMs }), true);
  assert.equal(c.record({ username: "a", text: "too late", at: endMs }), false);
  assert.equal(c.recordEvent({ kind: "gift", username: "a", amount: 5, at: endMs + 1 }), false);
  assert.equal(c.recordEvent({ kind: "gift", username: "a", amount: 5, at: startMs + 1000 }), true);
  const batch = c.drain();
  assert.equal(batch.emotes[0].count, 1);
  assert.equal(batch.events[0].amount, 5);
  assert.equal(c.stats.skippedOutsideWindow, 2);
  c.requeue(batch);
  assert.equal(c.drain().events.length, 1);
});

test("mass gifts are counted once, not again per recipient", () => {
  const c = createCollector({ channel: "streamer" });
  c.rememberMassGift("origin-1");
  assert.equal(c.isMassGiftPart({ "msg-param-origin-id": "origin-1" }), true);
  assert.equal(c.isMassGiftPart({ "msg-param-community-gift-id": "x" }), true);
  assert.equal(c.isMassGiftPart({ "msg-param-origin-id": "other" }), false);
});

test("aggregateEvents totals subs, finds the best day and ranks gifters", () => {
  const d1 = Date.UTC(2026, 9, 11, 14), d2 = d1 + 24 * H, d3 = d2 + 24 * H;
  const ev = (hour, kind, username, amount) => ({ hour, kind, username, display: username, amount });
  const rows = [
    ev(d1, "sub", "a", 3), ev(d1, "resub", "b", 2), ev(d1, "gift", "gifty", 10),
    ev(d2, "sub", "c", 20), ev(d2, "gift", "gifty", 5), ev(d2, "gift", "other", 6), ev(d2, "bits", "cheery", 500), ev(d3, "bits", "cheery", 100)
  ];
  const out = aggregateEvents(rows, { fromMs: d1 - H, toMs: d3 + 24 * H, tz: TZ, nowMs: d3 + 2 * H });
  assert.deepEqual(out.subs, { total: 46, new: 23, resub: 2, gifted: 21 });
  assert.equal(out.bits, 600);
  assert.deepEqual(out.bestDay, { day: "2026-10-12", subs: 31 });
  assert.equal(out.days, 3);
  assert.equal(out.avgPerDay, 15.3);
  assert.equal(out.today, 0);
  assert.deepEqual(out.gifters.map((g) => [g.username, g.gifted]), [["gifty", 15], ["other", 6]]);
  const narrow = aggregateEvents(rows, { fromMs: d2, toMs: d3, tz: TZ, nowMs: d3 });
  assert.equal(narrow.subs.total, 31);
});

test("aggregateEmotes ranks by count inside the range", () => {
  const t = Date.UTC(2026, 9, 12, 10);
  const rows = [{ hour: t, emote: "Kappa", emoteId: "25", count: 3 }, { hour: t + H, emote: "Kappa", emoteId: "25", count: 4 }, { hour: t, emote: "LUL", emoteId: "425618", count: 5 },
    { hour: t, emote: "ICANT", emoteId: "7tv:ABC", count: 9 }, { hour: t + 50 * H, emote: "PogChamp", emoteId: "1", count: 99 }];
  const out = aggregateEmotes(rows, { fromMs: t, toMs: t + 10 * H });
  assert.deepEqual(out.twitch.map((e) => [e.name, e.count]), [["Kappa", 7], ["LUL", 5]]);
  assert.deepEqual(out.sevenTv.map((e) => [e.name, e.count]), [["ICANT", 9]]);
  assert.equal(out.total, 21);
  assert.equal(out.distinct, 3);
});

test("7TV emotes are loaded from the channel and global sets and matched by name", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = url.endsWith("/emote-sets/global")
      ? { emotes: [{ id: "G1", name: "Clap" }, { id: "G2", name: "Shared" }] }
      : { emote_set: { emotes: [{ id: "C1", name: "OMEGALUL7" }, { id: "C2", name: "Shared" }] } };
    return { ok: true, json: async () => body };
  };
  const tv = createSevenTv({ fetchImpl, log: {} });
  assert.deepEqual(tv.match("OMEGALUL7"), [], "nothing before load");
  tv.start("12345");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.some((u) => u.endsWith("/users/twitch/12345")));
  assert.equal(tv.status.count, 3);
  assert.deepEqual(tv.match("hi OMEGALUL7 OMEGALUL7 Clap omegalul7"), [
    { id: "7tv:C1", name: "OMEGALUL7" }, { id: "7tv:C1", name: "OMEGALUL7" }, { id: "7tv:G1", name: "Clap" }]);
  assert.deepEqual(tv.match("Shared"), [{ id: "7tv:C2", name: "Shared" }], "channel set wins over global");
  assert.deepEqual(tv.match("Clap", new Set(["Clap"])), [], "already counted as a Twitch emote");
});

test("a failing 7TV request is recorded and does not throw", async () => {
  const tv = createSevenTv({ fetchImpl: async () => { throw new Error("offline"); }, log: {} });
  tv.start("1");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tv.status.loaded, false);
  assert.match(tv.status.lastError, /Request failed|offline|users\/twitch/);
});

function fakeTwitch({ live = true, chatters = [{ user_login: "fan1", user_name: "Fan1" }, { user_login: "nightbot", user_name: "Nightbot" }, { user_login: "Fan2", user_name: "Fan2" }], failChattersWith = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = new URL(url);
    const json = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    if (u.pathname === "/oauth2/token") {
      const p = new URLSearchParams(opts.body);
      if (p.get("grant_type") === "authorization_code") return json(200, { access_token: "A1", refresh_token: "R1", expires_in: 14000 });
      return json(200, { access_token: "A2", refresh_token: "R2", expires_in: 14000 });
    }
    if (u.pathname === "/oauth2/validate") return json(200, { user_id: "999", login: "streamer", scopes: ["moderator:read:chatters"] });
    if (u.pathname === "/helix/streams") return json(200, { data: live ? [{ id: "1" }] : [] });
    if (u.pathname === "/helix/chat/chatters") return failChattersWith ? json(failChattersWith, {}) : json(200, { data: chatters, pagination: {} });
    return json(404, {});
  };
  return { fetchImpl, calls };
}

function makeWatch(extra = {}) {
  const store = { auth: null, async getAuth() { return this.auth; }, async setAuth(a) { this.auth = a; } };
  const got = [];
  const tw = fakeTwitch(extra);
  let t = Date.UTC(2026, 9, 12, 12, 0, 0);
  const watch = createWatchtime({ clientId: "cid", clientSecret: "sec", store, onPresent: (p) => got.push(p), fetchImpl: tw.fetchImpl, now: () => t, log: {} });
  return { watch, store, got, tw, advance: (ms) => { t += ms; } };
}

test("watchtime stays off without a Twitch app", () => {
  const w = createWatchtime({ clientId: "", clientSecret: "", store: {}, onPresent() {}, log: {} });
  assert.equal(w.enabled, false);
});

test("connect link carries a one-time state and the callback stores the login", async () => {
  const { watch, store } = makeWatch();
  const url = new URL(watch.connectUrl("https://example.com/secret/auth/callback"));
  assert.equal(url.searchParams.get("scope"), "moderator:read:chatters");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/secret/auth/callback");
  const state = url.searchParams.get("state");
  await assert.rejects(watch.handleCallback({ code: "c", state: "wrong", redirectUri: "x" }), /expired|already used/);
  const login = await watch.handleCallback({ code: "c", state, redirectUri: "https://example.com/secret/auth/callback" });
  assert.equal(login, "streamer");
  assert.deepEqual(store.auth, { refreshToken: "R1", userId: "999", login: "streamer" });
  assert.equal(watch.status.connected, true);
  await assert.rejects(watch.handleCallback({ code: "c", state, redirectUri: "x" }), /expired|already used/, "state is single use");
});

test("each tick adds seconds for everyone in chat while live, skipping bots via the collector", async () => {
  const { watch, got, advance } = makeWatch();
  const state = new URL(watch.connectUrl("r")).searchParams.get("state");
  await watch.handleCallback({ code: "c", state, redirectUri: "r" });
  watch.start("12345");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(got.length >= 3, "first tick ran on start");
  assert.deepEqual(got.slice(0, 3).map((p) => [p.username, p.seconds]), [["fan1", 60], ["nightbot", 60], ["fan2", 60]]);
  got.length = 0;
  advance(65_000);
  await watch.tick();
  assert.equal(got[0].seconds, 65);
  assert.equal(watch.status.chattersNow, 3);
  assert.equal(watch.status.live, true);

  const c = createCollector({ channel: "streamer", window: { startMs: Date.UTC(2026, 9, 11), endMs: Date.UTC(2026, 9, 26) } });
  assert.equal(c.recordWatch({ username: "nightbot", seconds: 60, at: Date.UTC(2026, 9, 12) }), false, "bots are not counted");
  assert.equal(c.recordWatch({ username: "fan1", display: "Fan1", seconds: 60, at: Date.UTC(2026, 9, 12) }), true);
  assert.equal(c.recordWatch({ username: "fan1", seconds: 60, at: Date.UTC(2026, 9, 30) }), false, "outside the window");
  assert.equal(c.drain().watch[0].seconds, 60);
});

test("nothing is counted while the stream is offline", async () => {
  const { watch, got } = makeWatch({ live: false });
  const state = new URL(watch.connectUrl("r")).searchParams.get("state");
  await watch.handleCallback({ code: "c", state, redirectUri: "r" });
  watch.start("12345");
  await new Promise((r) => setTimeout(r, 20));
  await watch.tick();
  assert.equal(got.length, 0);
  assert.equal(watch.status.live, false);
});

test("a 403 from the chatters list is reported in plain words", async () => {
  const { watch, got } = makeWatch({ failChattersWith: 403 });
  const state = new URL(watch.connectUrl("r")).searchParams.get("state");
  await watch.handleCallback({ code: "c", state, redirectUri: "r" });
  watch.start("12345");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 0);
  assert.match(watch.status.lastError, /not the broadcaster or a moderator/);
});

test("saved login is picked up on restart and refreshed when it is old", async () => {
  const { watch, store, tw } = makeWatch();
  store.auth = { refreshToken: "R1", userId: "999", login: "streamer" };
  await watch.init();
  assert.equal(watch.status.connected, true);
  watch.start("12345");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(tw.calls.some((c) => c.url.endsWith("/oauth2/token")), "access token was fetched via the refresh token");
  assert.equal(store.auth.refreshToken, "R2");
});

test("watch-only people appear in the leaderboard with zero messages, and watchtime adds to the score", () => {
  const t0 = Date.UTC(2026, 9, 12, 10);
  const chat = [{ hour: t0, username: "chatty", display: "Chatty", role: "", messages: 10, words: 10, chars: 10, emotes: 0 }];
  const watchRows = [
    { hour: t0, username: "chatty", display: "Chatty", seconds: 3600 },
    { hour: t0, username: "lurker", display: "Lurker", seconds: 7200 },
    { hour: t0, username: "lurkmod", display: "LurkMod", seconds: 600 }
  ];
  const out = aggregate(chat, { fromMs: t0, toMs: t0 + 5 * H, tz: TZ, watchRows, staffNames: new Set(["lurkmod"]) });
  const by = Object.fromEntries(out.chatters.map((c) => [c.username, c]));
  assert.equal(by.chatty.watchSeconds, 3600);
  assert.equal(by.chatty.score, 10 + 5 + 2);
  assert.equal(by.lurker.messages, 0);
  assert.equal(by.lurker.watchSeconds, 7200);
  assert.deepEqual(out.staff.map((c) => c.username), ["lurkmod"]);
  assert.equal(out.totals.watchSeconds, 10800 + 600 - 0);
  assert.equal(out.totals.watchers, 3);
});
