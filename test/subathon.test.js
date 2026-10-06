import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, parseWhen, dayKey } from "../apps/subathon/stats.js";
import { createCollector, parseList } from "../apps/subathon/collector.js";

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
  const [row] = c.drain();
  assert.equal(row.messages, 2);
  assert.equal(row.words, 4);
  assert.equal(row.emotes, 2);
  assert.equal(row.display, "Fan");
  assert.equal(c.drain().length, 0);
});
