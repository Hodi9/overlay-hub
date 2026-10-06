import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, aggregateEmotes, aggregateEvents, goalProgress, parseGoals, parseWhen, dayKey } from "../apps/subathon/stats.js";
import { createCollector, extractEmotes, parseList } from "../apps/subathon/collector.js";

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

test("aggregateEvents totals subs, finds the best day and ranks gifters and cheerers", () => {
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
  assert.deepEqual(out.cheerers.map((g) => [g.username, g.bits]), [["cheery", 600]]);
  const narrow = aggregateEvents(rows, { fromMs: d2, toMs: d3, tz: TZ, nowMs: d3 });
  assert.equal(narrow.subs.total, 31);
});

test("aggregateEmotes ranks by count inside the range", () => {
  const t = Date.UTC(2026, 9, 12, 10);
  const rows = [{ hour: t, emote: "Kappa", emoteId: "25", count: 3 }, { hour: t + H, emote: "Kappa", emoteId: "25", count: 4 }, { hour: t, emote: "LUL", emoteId: "425618", count: 5 }, { hour: t + 50 * H, emote: "PogChamp", emoteId: "1", count: 99 }];
  const out = aggregateEmotes(rows, { fromMs: t, toMs: t + 10 * H });
  assert.deepEqual(out.top.map((e) => [e.name, e.count]), [["Kappa", 7], ["LUL", 5]]);
  assert.equal(out.total, 12);
});

test("goals parse from text and report reached or not", () => {
  const goals = parseGoals("1,000=Shave the beard; 500 = Ice bath ;bad;0=zero;2000=");
  assert.deepEqual(goals, [{ at: 500, label: "Ice bath" }, { at: 1000, label: "Shave the beard" }]);
  const p = goalProgress(goals, 600);
  assert.deepEqual(p.map((g) => g.reached), [true, false]);
  assert.equal(p[1].progress, 0.6);
});
