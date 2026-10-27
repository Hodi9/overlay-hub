import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import express from "express";
import tmi from "tmi.js";
import { parseIrcLine, parseUserNotice, tierOfPlan } from "../apps/subathon/ircParser.js";
import {
  DEFAULT_SETTINGS, LIMITS, ValidationError, addTime, cleanGoals, cleanSettings, createGiftTracker, createState, createTimer,
  goalProgress, pauseTimer, registerSubs, resetTimer, restoreState, serializeState, settleTimer, startTimer, timerView, undoTestEvents
} from "../apps/subathon/logic.js";
import { createSubathonApp } from "../apps/subathon/app.js";
import { createChannelRegistry } from "../apps/_lib/channels.js";

// No DATABASE_URL here: the subathon keeps its state in memory, which is all these tests need
// (apps/subathon saving and loading is in subathon-persist.test.js).
delete process.env.DATABASE_URL;
delete process.env.SUBATHON_TWITCH_CHANNEL;
process.env.SUBATHON_CONTROL_PASSWORD = "panel-secret";

// ---- sample lines ------------------------------------------------------------------------
// Shaped like what Twitch sends: tags in alphabetical order, spaces escaped as \s, no CRLF.

const escapeTag = (value) => String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\:").replace(/ /g, "\\s");
let lineNo = 0;
function usernotice(tags, { channel = "somestreamer", text = "" } = {}) {
  const all = {
    "badge-info": "subscriber/3", badges: "subscriber/3", color: "#1E90FF", "display-name": "Viewer_One", emotes: "", flags: "",
    id: `00000000-0000-4000-8000-${String(++lineNo).padStart(12, "0")}`, login: "viewer_one", mod: 0, "room-id": 12345,
    subscriber: 1, "tmi-sent-ts": 1700000000000, "user-id": 111, "user-type": "", ...tags
  };
  const encoded = Object.entries(all).map(([key, value]) => `${key}=${escapeTag(value)}`).join(";");
  return `@${encoded} :tmi.twitch.tv USERNOTICE #${channel}${text ? ` :${text}` : ""}`;
}

const sub = (plan = "1000", extra = {}) => usernotice({
  "msg-id": "sub", "msg-param-cumulative-months": 1, "msg-param-months": 0, "msg-param-should-share-streak": 0,
  "msg-param-sub-plan": plan, "msg-param-sub-plan-name": "Channel Subscription", "msg-param-was-gifted": "false",
  "system-msg": "Viewer_One subscribed at Tier 1.", ...extra
});
const resub = (plan = "1000", text = "Great stream!") => usernotice({
  "msg-id": "resub", "msg-param-cumulative-months": 8, "msg-param-months": 0, "msg-param-should-share-streak": 1, "msg-param-streak-months": 3,
  "msg-param-sub-plan": plan, "msg-param-sub-plan-name": "Channel Subscription", "system-msg": "Viewer_One subscribed at Tier 1. They've subscribed for 8 months!"
}, { text });
const GIFTER = { "display-name": "Big_Gifter", login: "big_gifter", "user-id": 333 };
const mysteryGift = (count, origin = "9b 2c 4f 11 a0 3d", plan = "1000") => usernotice({
  ...GIFTER, "msg-id": "submysterygift", "msg-param-mass-gift-count": count, "msg-param-origin-id": origin, "msg-param-sender-count": 17, "msg-param-sub-plan": plan,
  "system-msg": `Big_Gifter is gifting ${count} Tier 1 Subs to somestreamer's community!`
});
const subGift = (recipient, origin = "9b 2c 4f 11 a0 3d", plan = "1000") => usernotice({
  ...GIFTER, "msg-id": "subgift", "msg-param-gift-months": 1, "msg-param-months": 2, "msg-param-origin-id": origin,
  "msg-param-recipient-display-name": recipient, "msg-param-recipient-id": 222, "msg-param-recipient-user-name": recipient.toLowerCase(),
  "msg-param-sender-count": 0, "msg-param-sub-plan": plan, "msg-param-sub-plan-name": "Channel Subscription"
});

// ---- the IRC parser ----------------------------------------------------------------------

test("a line is split into tags, prefix, command and parameters, and tag escapes are undone", () => {
  const line = String.raw`@display-name=Some\sOne;system-msg=a\:b\\c;flag;empty= :tmi.twitch.tv USERNOTICE #somestreamer :hello there` + "\r\n";
  const parsed = parseIrcLine(line);
  assert.deepEqual(parsed.tags, { "display-name": "Some One", "system-msg": "a;b\\c", flag: "", empty: "" });
  assert.equal(parsed.prefix, "tmi.twitch.tv");
  assert.equal(parsed.command, "USERNOTICE");
  assert.deepEqual(parsed.params, ["#somestreamer", "hello there"]);

  assert.deepEqual(parseIrcLine("PING :tmi.twitch.tv"), { tags: {}, prefix: null, command: "PING", params: ["tmi.twitch.tv"] });
  assert.equal(parseIrcLine(""), null);
  assert.equal(parseIrcLine("@only=tags"), null);
  assert.equal(parseIrcLine(undefined), null);
});

test("a plain sub is read from a real-shaped USERNOTICE line", () => {
  const literal = String.raw`@badge-info=subscriber/1;badges=subscriber/0,premium/1;color=#1E90FF;display-name=Viewer_One;emotes=;flags=;id=3a8e1c5b-0a52-4f6b-9d53-6c1d2f5e7a10;login=viewer_one;mod=0;msg-id=sub;msg-param-cumulative-months=1;msg-param-months=0;msg-param-multimonth-duration=0;msg-param-multimonth-tenure=0;msg-param-should-share-streak=0;msg-param-sub-plan-name=Channel\sSubscription;msg-param-sub-plan=1000;msg-param-was-gifted=false;room-id=12345;subscriber=1;system-msg=Viewer_One\ssubscribed\sat\sTier\s1.;tmi-sent-ts=1700000000000;user-id=111;user-type= :tmi.twitch.tv USERNOTICE #SomeStreamer`;
  assert.deepEqual(parseUserNotice(literal), {
    id: "3a8e1c5b-0a52-4f6b-9d53-6c1d2f5e7a10", kind: "sub", channel: "somestreamer", user: "Viewer_One", login: "viewer_one",
    anonymous: false, tier: 1, prime: false, count: 1, recipient: null, giftKeys: []
  });
});

test("resubs, tiers and Prime", () => {
  const re = parseUserNotice(resub("2000"));
  assert.deepEqual([re.kind, re.tier, re.count, re.prime], ["resub", 2, 1, false]);
  assert.equal(parseUserNotice(sub("3000")).tier, 3);
  const prime = parseUserNotice(sub("Prime"));
  assert.deepEqual([prime.tier, prime.prime], [1, true]);
  assert.deepEqual([tierOfPlan("1000"), tierOfPlan("2000"), tierOfPlan("3000"), tierOfPlan("Prime"), tierOfPlan(undefined)], [1, 2, 3, 1, 1]);
});

test("a bulk gift is read with its size, a single gift with its recipient, and both carry the ids that tie them together", () => {
  const bulk = parseUserNotice(mysteryGift(20, "9b 2c 4f 11 a0 3d", "2000"));
  assert.deepEqual([bulk.kind, bulk.count, bulk.tier, bulk.user, bulk.recipient], ["submysterygift", 20, 2, "Big_Gifter", null]);
  assert.deepEqual(bulk.giftKeys, ["o:9b 2c 4f 11 a0 3d"]);

  const single = parseUserNotice(subGift("Lucky_One"));
  assert.deepEqual([single.kind, single.count, single.user, single.recipient], ["subgift", 1, "Big_Gifter", "Lucky_One"]);
  assert.deepEqual(single.giftKeys, bulk.giftKeys);

  const community = parseUserNotice(usernotice({ ...GIFTER, "msg-id": "subgift", "msg-param-community-gift-id": "1234567890", "msg-param-recipient-display-name": "X", "msg-param-sub-plan": "1000" }));
  assert.deepEqual(community.giftKeys, ["c:1234567890"]);
});

test("anonymous gifts are read as gifts from Anonymous", () => {
  const one = parseUserNotice(usernotice({ "msg-id": "subgift", login: "ananonymousgifter", "display-name": "AnAnonymousGifter", "msg-param-recipient-display-name": "Lucky_One", "msg-param-sub-plan": "1000" }));
  assert.deepEqual([one.kind, one.user, one.anonymous], ["subgift", "Anonymous", true]);
  const bulk = parseUserNotice(usernotice({ "msg-id": "anonsubmysterygift", "msg-param-mass-gift-count": 5, "msg-param-sub-plan": "1000" }));
  assert.deepEqual([bulk.kind, bulk.count, bulk.user], ["submysterygift", 5, "Anonymous"]);
});

test("lines that are not a paid sub are ignored", () => {
  const ignored = [
    usernotice({ "msg-id": "giftpaidupgrade", "msg-param-sender-login": "big_gifter", "msg-param-sender-name": "Big_Gifter", "msg-param-promo-name": "Subtember" }),
    usernotice({ "msg-id": "anongiftpaidupgrade", "msg-param-promo-name": "Subtember" }),
    usernotice({ "msg-id": "primepaidupgrade", "msg-param-sub-plan": "1000" }),
    usernotice({ "msg-id": "raid", "msg-param-displayName": "Raider", "msg-param-viewerCount": 42 }),
    usernotice({ "msg-id": "ritual", "msg-param-ritual-name": "new_chatter" }),
    "@badges=;display-name=Viewer_One;msg-id=sub :viewer_one!viewer_one@viewer_one.tmi.twitch.tv PRIVMSG #somestreamer :msg-id=sub",
    "PING :tmi.twitch.tv",
    ":tmi.twitch.tv 001 justinfan123 :Welcome, GLHF!",
    "",
    "not irc at all"
  ];
  for (const line of ignored) assert.equal(parseUserNotice(line), null, line);
});

test("odd gift sizes are kept within bounds", () => {
  assert.equal(parseUserNotice(mysteryGift(0)).count, 1);
  assert.equal(parseUserNotice(mysteryGift("abc")).count, 1);
  assert.equal(parseUserNotice(mysteryGift(999999)).count, 1000);
});

// ---- gifts are counted once --------------------------------------------------------------

const eventOf = (line) => parseUserNotice(line);
function creditAll(lines, tracker = createGiftTracker(), at = 1000) {
  return lines.map((line) => tracker.credit(eventOf(line), at).count);
}

test("a bulk gift followed by its single gifts is worth exactly the size of the bulk gift", () => {
  const counts = creditAll([mysteryGift(3), subGift("A"), subGift("B"), subGift("C")]);
  assert.deepEqual(counts, [3, 0, 0, 0]);
});

test("it does not matter if the single gifts arrive before the bulk gift", () => {
  const counts = creditAll([subGift("A"), subGift("B"), mysteryGift(3), subGift("C")]);
  assert.deepEqual(counts, [1, 1, 1, 0]);
  assert.equal(counts.reduce((a, b) => a + b), 3);
});

test("a bulk gift whose single gifts never arrive is still paid, and extra singles beyond it count on top", () => {
  assert.deepEqual(creditAll([mysteryGift(4)]), [4]);
  assert.deepEqual(creditAll([mysteryGift(2), subGift("A"), subGift("B"), subGift("C")]), [2, 0, 0, 1]);
});

test("a gift on its own is worth one, and separate gifts and bulk gifts do not swallow each other", () => {
  const tracker = createGiftTracker();
  assert.deepEqual(creditAll([subGift("A", "aa")], tracker), [1]);
  assert.deepEqual(creditAll([subGift("B", "bb")], tracker), [1]);
  assert.deepEqual(creditAll([mysteryGift(2, "cc"), subGift("C", "cc"), subGift("D", "cc"), mysteryGift(2, "dd"), subGift("E", "dd"), subGift("F", "dd")], tracker), [2, 0, 0, 2, 0, 0]);
  assert.deepEqual(creditAll([sub(), resub(), sub("2000")], tracker), [1, 1, 1]);
});

test("single gifts that carry no gift id are matched to the gifter's open bulk gift, but gifts with a different id are not", () => {
  const withoutIds = (line) => line.replace(/msg-param-origin-id=[^;]*;/, "");
  assert.deepEqual(creditAll([withoutIds(mysteryGift(2)), withoutIds(subGift("A")), withoutIds(subGift("B")), withoutIds(subGift("C"))]), [2, 0, 0, 1]);
  assert.deepEqual(creditAll([mysteryGift(2), withoutIds(subGift("A")), withoutIds(subGift("B"))]), [2, 0, 0]);
  // Both sides have ids and they differ: another gift, so it is paid for.
  assert.deepEqual(creditAll([mysteryGift(2, "one-id"), subGift("A", "another-id")]), [2, 1]);
});

test("two gifts are never taken for one, even when Twitch gives them the same gift id", () => {
  const SAME = "da 39 a3 ee 5e 6b 4b 0d 32 55 bf ef 95 60 18 90 af d8 07 09";
  const otherGifter = (line) => line.replace("login=big_gifter", "login=other_gifter").replace("display-name=Big_Gifter", "display-name=Other_Gifter");
  const tracker = createGiftTracker();
  // One bulk gift of 2, completed; then another bulk gift of 3 from the same gifter with the same id.
  assert.deepEqual(creditAll([mysteryGift(2, SAME), subGift("A", SAME), subGift("B", SAME), mysteryGift(3, SAME), subGift("C", SAME), subGift("D", SAME), subGift("E", SAME)], tracker), [2, 0, 0, 3, 0, 0, 0]);
  // Another gifter's gifts with the same id as an open bulk gift are their own: a single one is paid for, a bulk one has its own singles.
  assert.deepEqual(creditAll([mysteryGift(4, SAME), otherGifter(subGift("X", SAME)), subGift("A", SAME)], createGiftTracker()), [4, 1, 0]);
  assert.deepEqual(creditAll([mysteryGift(4, SAME), otherGifter(mysteryGift(2, SAME)), otherGifter(subGift("X", SAME)), subGift("A", SAME)], createGiftTracker()), [4, 2, 0, 0]);
  // A lone gift now and then, all with the same id, are each paid for.
  assert.deepEqual(creditAll([subGift("A", SAME), subGift("B", SAME), subGift("C", SAME)], createGiftTracker()), [1, 1, 1]);
});

test("a bulk gift only takes in single gifts that came right before it", () => {
  const tracker = createGiftTracker({ adoptMs: 10_000 });
  assert.equal(tracker.credit(eventOf(subGift("A", "x")), 0).count, 1);
  assert.equal(tracker.credit(eventOf(mysteryGift(2, "x")), 5_000).count, 1); // the single before it is part of the 2
  assert.equal(tracker.credit(eventOf(subGift("B", "y")), 100_000).count, 1);
  assert.equal(tracker.credit(eventOf(mysteryGift(2, "y")), 130_000).count, 2); // a lone gift half a minute earlier is not
});

test("the tier of a bulk gift is the tier that is paid out", () => {
  const tracker = createGiftTracker();
  assert.deepEqual(tracker.credit(eventOf(mysteryGift(5, "t3", "3000")), 0), { tier: 3, count: 5 });
  assert.deepEqual(tracker.credit(eventOf(subGift("A", "t3", "3000")), 0), { tier: 3, count: 0 });
});

test("old groups are forgotten, so a reused id much later counts again", () => {
  const tracker = createGiftTracker({ windowMs: 1000 });
  assert.equal(tracker.credit(eventOf(mysteryGift(2, "same")), 0).count, 2);
  assert.equal(tracker.credit(eventOf(mysteryGift(2, "same")), 5000).count, 2);
});

// ---- the timer ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

test("a running timer counts down with the clock, a paused one stands still", () => {
  let timer = startTimer(createTimer(60_000), T0);
  assert.equal(timer.status, "running");
  assert.equal(timerView(timer, T0 + 10_000).remainingMs, 50_000);
  timer = pauseTimer(timer, T0 + 10_000);
  assert.deepEqual([timer.status, timer.remainingMs], ["paused", 50_000]);
  assert.equal(timerView(timer, T0 + 999_000).remainingMs, 50_000);
  timer = startTimer(timer, T0 + 20_000);
  assert.equal(timerView(timer, T0 + 25_000).remainingMs, 45_000);
});

test("a timer that reaches zero is ended and cannot be started again", () => {
  const timer = startTimer(createTimer(5000), T0);
  assert.deepEqual(timerView(timer, T0 + 5000), { status: "ended", remainingMs: 0, addedMs: 0 });
  assert.equal(timerView(timer, T0 + 4999).status, "running");
  assert.equal(startTimer(settleTimer(timer, T0 + 6000), T0 + 7000).status, "ended");
  assert.equal(startTimer(createTimer(0), T0).status, "idle"); // nothing to run
});

test("time is added to a running timer from where it is now", () => {
  const timer = startTimer(createTimer(60_000), T0);
  const { timer: next, appliedMs } = addTime(timer, 20_000, T0 + 10_000);
  assert.equal(appliedMs, 20_000);
  assert.equal(timerView(next, T0 + 10_000).remainingMs, 70_000);
  assert.equal(timerView(next, T0 + 30_000).remainingMs, 50_000);
  assert.equal(next.addedMs, 20_000);
});

test("the maximum time cuts off what would go past it, but never shortens a timer that is already above it", () => {
  const timer = createTimer(95_000);
  assert.equal(addTime(timer, 20_000, T0, { maxMs: 100_000 }).appliedMs, 5000);
  assert.equal(addTime(createTimer(100_000), 20_000, T0, { maxMs: 100_000 }).appliedMs, 0);
  const above = addTime(createTimer(150_000), 20_000, T0, { maxMs: 100_000 });
  assert.deepEqual([above.appliedMs, above.timer.remainingMs], [0, 150_000]);
  assert.equal(addTime(timer, -20_000, T0, { maxMs: 100_000 }).appliedMs, -20_000); // taking time away is never limited
  assert.equal(addTime(timer, 20_000, T0, { maxMs: 0 }).appliedMs, 20_000); // 0 = no limit
});

test("an ended timer takes no sub time, but a manual change brings it back paused", () => {
  const ended = settleTimer(startTimer(createTimer(1000), T0), T0 + 2000);
  assert.deepEqual(addTime(ended, 20_000, T0 + 3000), { timer: ended, appliedMs: 0 });
  const revived = addTime(ended, 60_000, T0 + 3000, { revive: true }).timer;
  assert.deepEqual([revived.status, revived.remainingMs], ["paused", 60_000]);
});

test("taking away more time than is left ends a running timer and never goes below zero", () => {
  const running = startTimer(createTimer(30_000), T0);
  const result = addTime(running, -45_000, T0 + 10_000, { revive: true });
  assert.deepEqual([result.timer.status, result.timer.remainingMs, result.appliedMs], ["ended", 0, -20_000]);
  const paused = addTime(createTimer(10_000), -45_000, T0);
  assert.deepEqual([paused.timer.remainingMs, paused.appliedMs], [0, -10_000]);
});

test("a reset gives a fresh timer", () => {
  const used = addTime(startTimer(createTimer(60_000), T0), 20_000, T0).timer;
  assert.deepEqual(resetTimer(3_600_000), { status: "idle", remainingMs: 3_600_000, anchor: null, addedMs: 0 });
  assert.equal(used.addedMs, 20_000);
});

// ---- settings and goals ------------------------------------------------------------------

test("settings are checked, and what is left out keeps its value", () => {
  assert.deepEqual(cleanSettings({ secondsPerSub: { t1: 30 } }), { ...DEFAULT_SETTINGS, secondsPerSub: { t1: 30, t2: 40, t3: 100 } });
  assert.equal(cleanSettings({ secondsPerSub: { t1: "12.6" } }).secondsPerSub.t1, 13);
  for (const bad of [{ secondsPerSub: { t1: -1 } }, { secondsPerSub: { t2: "abc" } }, { secondsPerSub: { t3: "" } }, { secondsPerSub: { t1: LIMITS.secondsPerSub + 1 } }, { maxSeconds: null }, { startSeconds: Infinity }]) {
    assert.throws(() => cleanSettings(bad), ValidationError, JSON.stringify(bad));
  }
  assert.throws(() => cleanSettings({ startSeconds: 7200, maxSeconds: 3600 }), /Starttiden/);
});

test("goals are sorted, trimmed and keep their ids", () => {
  const goals = cleanGoals([{ id: "keepthisid", title: "  Big one ", target: 100 }, { title: "Small", target: "25" }]);
  assert.deepEqual(goals.map((goal) => [goal.title, goal.target]), [["Small", 25], ["Big one", 100]]);
  assert.equal(goals[1].id, "keepthisid");
  assert.match(goals[0].id, /^[a-z0-9]{4,24}$/);
  assert.equal(new Set(cleanGoals([{ id: "dupe1234", title: "a", target: 1 }, { id: "dupe1234", title: "b", target: 2 }]).map((goal) => goal.id)).size, 2);
  assert.deepEqual(cleanGoals([]), []);
});

test("bad goals are refused", () => {
  for (const bad of [null, "x", [{ title: "", target: 5 }], [{ title: "No target" }], [{ title: "Zero", target: 0 }], [{ title: "Half", target: 2.5 }], [{ title: "Huge", target: LIMITS.count + 1 }],
    Array.from({ length: LIMITS.goals + 1 }, (_, i) => ({ title: `g${i}`, target: i + 1 }))]) {
    assert.throws(() => cleanGoals(bad), ValidationError, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("goal progress marks reached goals and finds the next one", () => {
  const goals = cleanGoals([{ title: "A", target: 10 }, { title: "B", target: 50 }, { title: "C", target: 100 }]);
  const mid = goalProgress(goals, 50);
  assert.deepEqual(mid.goals.map((goal) => goal.reached), [true, true, false]);
  assert.equal(mid.next.title, "C");
  assert.equal(goalProgress(goals, 49).next.title, "B");
  assert.equal(goalProgress(goals, 100).next, null);
  assert.equal(goalProgress([], 5).next, null);
});

// ---- paying out subs ---------------------------------------------------------------------

function freshState() {
  const state = createState();
  state.settings = cleanSettings({ secondsPerSub: { t1: 20, t2: 40, t3: 100 }, startSeconds: 3600 });
  state.timer = resetTimer(3_600_000);
  return state;
}

test("a sub adds the seconds for its tier, counts up, and shows in the list", () => {
  const state = freshState();
  const entry = registerSubs(state, { kind: "sub", user: "Viewer_One", tier: 1, count: 1 }, T0);
  assert.deepEqual([entry.addedMs, entry.count, entry.user], [20_000, 1, "Viewer_One"]);
  registerSubs(state, { kind: "resub", user: "Two", tier: 2, count: 1 }, T0);
  registerSubs(state, { kind: "sub", user: "Three", tier: 3, count: 1 }, T0);
  assert.equal(state.count, 3);
  assert.equal(state.timer.remainingMs, 3_600_000 + 160_000);
  assert.equal(state.timer.addedMs, 160_000);
  assert.deepEqual(state.events.map((e) => e.user), ["Three", "Two", "Viewer_One"]);
});

test("a gift of several subs adds time for every one of them", () => {
  const state = freshState();
  registerSubs(state, { kind: "submysterygift", user: "Big_Gifter", tier: 1, count: 10 }, T0);
  assert.equal(state.count, 10);
  assert.equal(state.timer.remainingMs, 3_600_000 + 200_000);
  assert.equal(registerSubs(state, { kind: "sub", user: "x", tier: 1, count: 0 }, T0), null);
});

test("with a maximum time the surplus is lost, but the subs still count", () => {
  const state = freshState();
  state.settings = cleanSettings({ maxSeconds: 3610 }, state.settings);
  const entry = registerSubs(state, { kind: "sub", user: "A", tier: 1, count: 1 }, T0);
  assert.equal(entry.addedMs, 10_000);
  assert.equal(registerSubs(state, { kind: "sub", user: "B", tier: 1, count: 1 }, T0).addedMs, 0);
  assert.deepEqual([state.count, state.timer.remainingMs], [2, 3_610_000]);
});

test("after the timer has ended a sub only counts", () => {
  const state = freshState();
  state.timer = settleTimer(startTimer(createTimer(1000), T0), T0 + 5000);
  const entry = registerSubs(state, { kind: "sub", user: "Late", tier: 1, count: 1 }, T0 + 6000);
  assert.deepEqual([entry.addedMs, state.count, state.timer.status, state.timer.remainingMs], [0, 1, "ended", 0]);
});

test("test subs are taken back without touching the real ones", () => {
  const state = freshState();
  registerSubs(state, { kind: "sub", user: "Real", tier: 1, count: 1 }, T0);
  registerSubs(state, { kind: "submysterygift", user: "Test", tier: 2, count: 5, test: true }, T0);
  registerSubs(state, { kind: "sub", user: "Test", tier: 1, count: 1, test: true }, T0);
  assert.equal(state.count, 7);
  assert.equal(undoTestEvents(state, T0), 2);
  assert.deepEqual([state.count, state.timer.remainingMs, state.timer.addedMs], [1, 3_620_000, 20_000]);
  assert.deepEqual(state.events.map((e) => e.user), ["Real"]);
  assert.equal(undoTestEvents(state, T0), 0);
});

test("the list keeps the latest events only", () => {
  const state = freshState();
  for (let i = 0; i < LIMITS.events + 10; i++) registerSubs(state, { kind: "sub", user: `U${i}`, tier: 1, count: 1 }, T0);
  assert.equal(state.events.length, LIMITS.events);
  assert.equal(state.events[0].user, `U${LIMITS.events + 9}`);
});

test("a state survives being saved and restored, and bad data falls back to defaults", () => {
  const state = freshState();
  state.timer = startTimer(state.timer, T0);
  registerSubs(state, { kind: "sub", user: "A", tier: 2, count: 1 }, T0 + 1000);
  state.goals = cleanGoals([{ title: "Goal", target: 7 }]);
  state.twitch = "somestreamer";
  const restored = restoreState(JSON.parse(JSON.stringify(serializeState(state))));
  assert.deepEqual(restored, state);
  assert.equal(timerView(restored.timer, T0 + 11_000).remainingMs, timerView(state.timer, T0 + 11_000).remainingMs);

  const broken = restoreState({ settings: { secondsPerSub: { t1: -5 } }, timer: { status: "running", remainingMs: "x" }, count: -3, goals: "no", events: [null, 5, { id: "ok", count: 1, addedMs: 0 }], twitch: 42 }, { twitch: "fallback" });
  assert.deepEqual(broken.settings, DEFAULT_SETTINGS);
  assert.deepEqual([broken.timer.status, broken.timer.remainingMs, broken.count, broken.twitch], ["idle", 3_600_000, 0, "fallback"]);
  assert.equal(broken.goals.length, 1);
  assert.deepEqual(broken.events.map((e) => e.id), ["ok"]);
  assert.equal(restoreState({ timer: { status: "running", remainingMs: 5000 } }).timer.status, "paused"); // a running timer without an anchor cannot run
  assert.equal(restoreState(null).count, 0);
});

// ---- the pages ---------------------------------------------------------------------------

test("the scripts in the overlay and the control panel parse (a script error silently kills the whole page)", () => {
  for (const name of ["index.html", "control.html"]) {
    const html = fs.readFileSync(new URL(`../apps/subathon/public/${name}`, import.meta.url), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length, name);
    for (const [, code] of scripts) assert.doesNotThrow(() => new vm.Script(code, { filename: name }), name);
  }
});

// ---- the app, from a chat line to the overlay --------------------------------------------

const chatClients = [];
tmi.Client.prototype.connect = async function () { return ["irc-ws.chat.twitch.tv", 443]; };
tmi.Client.prototype.join = async function (channel) { chatClients.push({ client: this, channel }); return [channel]; };

describe("the subathon app", () => {
  const clock = { t: T0 };
  const registry = createChannelRegistry();
  let server;
  let base;
  before(async () => {
    const app = express();
    app.use("/subathon", createSubathonApp({ channels: registry, now: () => clock.t }));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.closeAllConnections?.(); server.close(); });


  // The line arrives the way tmi.js hands it over: the parsed message, whose `raw` is the IRC text.
  const hear = (line) => {
    const client = chatClients[0].client;
    client.emit("raw_message", {}, { raw: line, command: parseIrcLine(line)?.command });
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

  const PANEL = { "x-subathon-key": "panel-secret" };
  const jsonHeaders = (extra) => ({ "Content-Type": "application/json", ...extra });
  const get = async (path) => (await fetch(`${base}/subathon/api${path}`)).json();
  const post = (path, body = {}, headers = PANEL) => fetch(`${base}/subathon/api${path}`, { method: "POST", headers: jsonHeaders(headers), body: JSON.stringify(body) });
  const postOk = async (path, body, headers) => {
    const response = await post(path, body, headers);
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(await response.clone().json())}`);
    return response.json();
  };

  test("the panel needs the password, the overlay does not", async () => {
    const before = await get("/state");
    assert.deepEqual([before.timer.status, before.timer.remainingMs, before.count, before.passwordRequired], ["idle", 3_600_000, 0, true]);
    assert.equal(before.goals[0].title, "Sub goal");

    assert.equal((await post("/timer/start", {}, {})).status, 401);
    assert.equal((await post("/timer/start", {}, { "x-subathon-key": "wrong" })).status, 401);
    assert.equal((await post("/simulate", { kind: "sub", tier: 1 }, {})).status, 401);
    assert.equal((await get("/state")).timer.status, "idle");

    const started = await postOk("/timer/start");
    assert.equal(started.timer.status, "running");
  });

  test("a sub line from Twitch chat adds the time for its tier and counts up", async () => {
    await postOk("/twitch", { twitch: "SomeStreamer" });
    assert.deepEqual(chatClients.map((c) => c.channel), ["somestreamer"]);
    await settle();
    assert.equal((await get("/state")).chatConnected, true);

    hear(sub("1000"));
    await settle();
    let state = await get("/state");
    assert.deepEqual([state.count, state.timer.remainingMs], [1, 3_620_000]);
    assert.deepEqual([state.events[0].user, state.events[0].kind, state.events[0].addedMs, state.events[0].test], ["Viewer_One", "sub", 20_000, false]);

    hear(resub("2000"));
    hear(sub("3000"));
    await settle();
    state = await get("/state");
    assert.deepEqual([state.count, state.timer.remainingMs, state.timer.addedMs], [3, 3_600_000 + 160_000, 160_000]);
  });

  test("a bulk gift and its single gifts add time once, whatever the order", async () => {
    const before = await get("/state");
    hear(mysteryGift(3, "app-bulk-1"));
    hear(subGift("A", "app-bulk-1"));
    hear(subGift("B", "app-bulk-1"));
    hear(subGift("C", "app-bulk-1"));
    await settle();
    let state = await get("/state");
    assert.deepEqual([state.count - before.count, state.timer.remainingMs - before.timer.remainingMs], [3, 60_000]);
    assert.equal(state.events.filter((e) => e.kind === "submysterygift").length, 1);
    assert.equal(state.events.filter((e) => e.kind === "subgift").length, 0);

    hear(subGift("D", "app-bulk-2"));
    hear(subGift("E", "app-bulk-2"));
    hear(mysteryGift(2, "app-bulk-2"));
    await settle();
    const after = await get("/state");
    assert.deepEqual([after.count - state.count, after.timer.remainingMs - state.timer.remainingMs], [2, 40_000]);
  });

  test("the same line twice, other lines and other channels change nothing", async () => {
    const before = await get("/state");
    const once = sub("1000");
    hear(once);
    hear(once);
    hear(usernotice({ "msg-id": "giftpaidupgrade", "msg-param-sender-login": "big_gifter" }));
    hear(usernotice({ "msg-id": "raid", "msg-param-viewerCount": 10 }));
    hear(usernotice({ "msg-id": "sub", "msg-param-sub-plan": "1000" }, { channel: "someoneelse" }));
    hear("PING :tmi.twitch.tv");
    await settle();
    const after = await get("/state");
    assert.deepEqual([after.count - before.count, after.timer.remainingMs - before.timer.remainingMs], [1, 20_000]);
  });

  test("the test buttons take the same road, and can be taken back", async () => {
    const before = await get("/state");
    let state = await postOk("/simulate", { kind: "sub", tier: 2 });
    assert.deepEqual([state.count - before.count, state.timer.remainingMs - before.timer.remainingMs, state.events[0].test], [1, 40_000, true]);
    state = await postOk("/simulate", { kind: "submysterygift", tier: 1, count: 10 });
    assert.deepEqual([state.count - before.count, state.timer.remainingMs - before.timer.remainingMs], [11, 240_000]);
    state = await postOk("/simulate", { kind: "subgift", tier: 3 });
    assert.equal(state.timer.remainingMs - before.timer.remainingMs, 340_000);

    state = await postOk("/undo-tests");
    assert.deepEqual([state.count, state.timer.remainingMs, state.timer.addedMs], [before.count, before.timer.remainingMs, before.timer.addedMs]);
    assert.equal(state.events.some((e) => e.test), false);

    assert.equal((await post("/simulate", { kind: "raid", tier: 1 })).status, 400);
    assert.equal((await post("/simulate", { kind: "sub", tier: 4 })).status, 400);
    assert.equal((await post("/simulate", { kind: "submysterygift", tier: 1, count: 101 })).status, 400);
  });

  test("changing the seconds per sub, the maximum and the start time", async () => {
    let state = await postOk("/settings", { secondsPerSub: { t1: 30, t2: 60, t3: 150 } });
    assert.deepEqual(state.settings.secondsPerSub, { t1: 30, t2: 60, t3: 150 });
    const before = state.timer.remainingMs;
    state = await postOk("/simulate", { kind: "sub", tier: 1 });
    assert.equal(state.timer.remainingMs - before, 30_000);

    state = await postOk("/settings", { maxSeconds: Math.round(state.timer.remainingMs / 1000) + 10 });
    const full = state.timer.remainingMs;
    state = await postOk("/simulate", { kind: "sub", tier: 1 });
    assert.equal(state.timer.remainingMs - full, 10_000);
    assert.equal(state.events[0].addedMs, 10_000);
    await postOk("/undo-tests");
    await postOk("/settings", { maxSeconds: 0, secondsPerSub: { t1: 20, t2: 40, t3: 100 } });

    for (const bad of [{ secondsPerSub: { t1: -1 } }, { secondsPerSub: { t2: "lots" } }, { startSeconds: "x" }]) {
      const response = await post("/settings", bad);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /skal være/);
    }
    assert.equal((await get("/state")).settings.secondsPerSub.t1, 20);
  });

  test("the timer runs out with the clock, then takes no sub time until it is topped up by hand", async () => {
    await postOk("/reset", { what: "all" });
    await postOk("/settings", { startSeconds: 120 });
    await postOk("/reset", { what: "timer" });
    let state = await postOk("/timer/start");
    assert.deepEqual([state.timer.status, state.timer.remainingMs], ["running", 120_000]);

    clock.t += 30_000;
    state = await get("/state");
    assert.equal(state.timer.remainingMs, 90_000);
    state = await postOk("/timer/pause");
    clock.t += 60_000;
    assert.equal((await get("/state")).timer.remainingMs, 90_000);

    await postOk("/timer/start");
    clock.t += 91_000;
    state = await get("/state");
    assert.deepEqual([state.timer.status, state.timer.remainingMs], ["ended", 0]);

    hear(sub("1000"));
    await settle();
    state = await get("/state");
    assert.deepEqual([state.count, state.timer.remainingMs, state.events[0].addedMs], [1, 0, 0]);

    state = await postOk("/timer/add", { seconds: 90 });
    assert.deepEqual([state.timer.status, state.timer.remainingMs], ["paused", 90_000]);
    state = await postOk("/timer/add", { seconds: -30 });
    assert.equal(state.timer.remainingMs, 60_000);
    assert.equal((await post("/timer/add", { seconds: "soon" })).status, 400);
    await postOk("/settings", { startSeconds: 3600 });
  });

  test("an unstarted timer follows the start time, a used one keeps its own", async () => {
    await postOk("/reset", { what: "all" });
    let state = await postOk("/settings", { startSeconds: 7200 });
    assert.deepEqual([state.timer.status, state.timer.remainingMs], ["idle", 7_200_000]);
    await postOk("/timer/add", { seconds: 60 });
    state = await postOk("/settings", { startSeconds: 1800 });
    assert.equal(state.timer.remainingMs, 7_260_000);
    state = await postOk("/reset", { what: "timer" });
    assert.equal(state.timer.remainingMs, 1_800_000);
    await postOk("/settings", { startSeconds: 3600 });
    await postOk("/reset", { what: "timer" });
  });

  test("counter and goals can be edited, and goals are reached as the count passes them", async () => {
    await postOk("/reset", { what: "all" });
    let state = await postOk("/goals", { goals: [{ title: "Second", target: 20 }, { title: "First", target: 5 }] });
    assert.deepEqual(state.goals.map((g) => g.title), ["First", "Second"]);
    assert.equal(state.nextGoalId, state.goals[0].id);

    state = await postOk("/count", { count: 5 });
    assert.deepEqual([state.goals[0].reached, state.goals[1].reached, state.nextGoalId], [true, false, state.goals[1].id]);
    state = await postOk("/count", { delta: -1 });
    assert.equal(state.count, 4);
    assert.equal(state.nextGoalId, state.goals[0].id);

    const edited = state.goals.map((g) => (g.title === "Second" ? { ...g, title: "Second, renamed", target: 4 } : g));
    state = await postOk("/goals", { goals: edited });
    assert.deepEqual(state.goals.map((g) => [g.title, g.target, g.reached]), [["Second, renamed", 4, true], ["First", 5, false]]);

    state = await postOk("/goals", { goals: [] });
    assert.deepEqual([state.goals, state.nextGoalId], [[], null]);

    for (const [path, body] of [["/count", { count: -1 }], ["/count", { count: 1.5 }], ["/count", { delta: "x" }], ["/goals", { goals: [{ title: "", target: 3 }] }], ["/goals", { goals: "none" }]]) {
      assert.equal((await post(path, body)).status, 400, `${path} ${JSON.stringify(body)}`);
    }
    assert.equal((await get("/state")).count, 4);
    await postOk("/goals", { goals: [{ title: "Sub goal", target: 50 }] });
  });

  test("the Twitch name is checked, and a new overlay is told at once over the live stream", async () => {
    assert.equal((await post("/twitch", { twitch: "not a name!" })).status, 400);
    const controller = new AbortController();
    const stream = await fetch(`${base}/subathon/api/events`, { signal: controller.signal });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const next = async (predicate) => {
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value);
        for (const message of buffer.split("\n\n")) {
          if (message.startsWith("data:") && predicate(JSON.parse(message.slice(5)))) return JSON.parse(message.slice(5));
        }
      }
    };
    const first = await next(() => true);
    const heard = next((s) => s.count === first.count + 1);
    await postOk("/simulate", { kind: "sub", tier: 1 });
    const update = await heard;
    controller.abort();
    assert.equal(update.events[0].test, true);
    await postOk("/undo-tests");
  });

  test("channels have their own subathon, protected by their own keys, and read the chat of their Twitch name", async () => {
    const first = await registry.create({ twitch: "someoneelse" });
    const second = await registry.create({ twitch: "someoneelse" });
    const third = await registry.create({});
    const as = (channel, key) => ({ path: (p) => `${p}?profile=${channel.id}`, headers: { "x-channel-key": key } });
    const one = as(first, first.ownerKey), two = as(second, second.ownerKey), none = as(third, third.ownerKey);
    const hubGet = async (who, path) => (await fetch(`${base}/subathon/api${who.path(path)}`)).json();
    const hubPost = (who, path, body = {}, headers = who.headers) => fetch(`${base}/subathon/api${who.path(path)}`, { method: "POST", headers: jsonHeaders(headers), body: JSON.stringify(body) });

    assert.equal((await fetch(`${base}/subathon/api/state?profile=nosuchchannel`)).status, 404);
    const fresh = await hubGet(one, "/state");
    assert.deepEqual([fresh.passwordRequired, fresh.twitch, fresh.twitchEditable, fresh.count], [true, "someoneelse", false, 0]);

    assert.equal((await hubPost(one, "/simulate", { kind: "sub", tier: 1 }, {})).status, 401); // no key
    assert.equal((await hubPost(one, "/simulate", { kind: "sub", tier: 1 }, PANEL)).status, 401); // the main panel's password is not a channel key
    assert.equal((await hubPost(one, "/simulate", { kind: "sub", tier: 1 }, two.headers)).status, 401); // another channel's key
    assert.equal((await hubPost(one, "/twitch", { twitch: "x" })).status, 400); // channels set it on the channel page

    await settle();
    assert.ok(chatClients.some((c) => c.channel === "someoneelse"));
    await hubGet(two, "/state");
    const mainBefore = await get("/state");
    hear(usernotice({ "msg-id": "sub", "msg-param-sub-plan": "2000", "display-name": "Fan" }, { channel: "someoneelse" }));
    await settle();

    const a = await hubGet(one, "/state"), b = await hubGet(two, "/state"), c = await hubGet(none, "/state"), main = await get("/state");
    assert.deepEqual([a.count, a.timer.remainingMs, a.events[0].user], [1, 3_640_000, "Fan"]);
    assert.deepEqual([b.count, b.timer.remainingMs], [1, 3_640_000]); // two channels on the same Twitch name both count it
    assert.deepEqual([c.count, c.twitch, c.chatConnected], [0, null, false]);
    assert.equal(main.count, mainBefore.count);

    const manual = await (await hubPost(one, "/timer/start")).json();
    assert.equal(manual.timer.status, "running");
    assert.equal((await hubGet(two, "/state")).timer.status, "idle");
  });
});
