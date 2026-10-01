import test from "node:test";
import assert from "node:assert/strict";
import { isModOrBroadcaster, parseGoalCommand } from "../apps/subcount/commands.js";
import { createTwitchApi } from "../apps/subcount/twitchApi.js";

test("parses absolute and relative goal commands", () => {
  assert.equal(parseGoalCommand("!subgoal 500", "!subgoal"), 500);
  assert.equal(parseGoalCommand("  !SubGoal   250 ", "!subgoal"), 250);
  assert.equal(parseGoalCommand("!subgoal +10", "!subgoal", 90), 100);
  assert.equal(parseGoalCommand("!subgoal -5", "!subgoal", 100), 95);
  assert.equal(parseGoalCommand("!subgoal -500", "!subgoal", 100), 0);
});

test("ignores anything that isn't a clean goal command", () => {
  for (const msg of ["!subgoal", "!subgoal abc", "!subgoal 1.5", "!subgoal 10 20", "hello !subgoal 5", "!subgoals 5", "!subgoal 99999999"]) {
    assert.equal(parseGoalCommand(msg, "!subgoal", 0), null, msg);
  }
});

test("only broadcaster and mods may set the goal", () => {
  assert.equal(isModOrBroadcaster({ badges: { broadcaster: "1" } }), true);
  assert.equal(isModOrBroadcaster({ mod: true }), true);
  assert.equal(isModOrBroadcaster({ "user-type": "mod" }), true);
  assert.equal(isModOrBroadcaster({ badges: { subscriber: "1" } }), false);
  assert.equal(isModOrBroadcaster({}), false);
});

test("Helix client sends bearer + client id and reads the sub total", async () => {
  const calls = [];
  const api = createTwitchApi({
    clientId: "cid", clientSecret: "sec",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ total: 42, data: [] }) };
    }
  });
  assert.equal(await api.getSubTotal("123", "tok"), 42);
  assert.match(calls[0].url, /helix\/subscriptions\?broadcaster_id=123/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.equal(calls[0].init.headers["Client-Id"], "cid");
  assert.match(api.authorizeUrl("https://x/cb", "st"), /scope=channel%3Aread%3Asubscriptions/);
});
