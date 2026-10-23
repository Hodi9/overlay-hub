import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUESTS } from "../apps/cyberpunk/quests.js";
import { cleanQuest } from "../apps/cyberpunk/app.js";
import { computeProgress, describePhase } from "../apps/cyberpunk/public/progress.js";

const jobs = (...parts) => parts.map((part, i) => ({ id: String(i), day: `job ${i}`, part }));

test("default quest list has unique names and only known parts", () => {
  const names = DEFAULT_QUESTS.map((q) => q.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  for (const quest of DEFAULT_QUESTS) {
    assert.ok(quest.name.length > 0);
    assert.ok(["base", "phantom"].includes(quest.part), `${quest.name}: ${quest.part}`);
  }
  assert.ok(DEFAULT_QUESTS.some((q) => q.part === "phantom"));
  assert.ok(DEFAULT_QUESTS.some((q) => q.part === "base"));
});

test("cleanQuest maps the quest list shape onto the shared tracker shape", () => {
  const cleaned = cleanQuest({ name: "  Dog Eat Dog ", act: "Dogtown", part: "phantom" });
  assert.equal(cleaned.day, "Dog Eat Dog");
  assert.equal(cleaned.location, "Dogtown");
  assert.equal(cleaned.part, "phantom");
  assert.ok(cleaned.id);

  // Round-trips its own output (what the control panel PUTs back).
  assert.deepEqual(cleanQuest(cleaned), cleaned);

  // Unknown or missing parts fall back to the base game.
  assert.equal(cleanQuest({ name: "x", part: "dlc2" }).part, "base");
  assert.equal(cleanQuest({ name: "x" }).part, "base");
});

test("computeProgress counts Phantom Liberty jobs when included", () => {
  const list = jobs("base", "base", "phantom", "phantom", "base");
  assert.deepEqual(computeProgress(list, 3, true), { completed: 3, total: 5, percent: 60, finished: false });
});

test("computeProgress drops Phantom Liberty jobs from done and total when excluded", () => {
  const list = jobs("base", "base", "phantom", "phantom", "base");
  // index < 3 covers base, base, phantom — only the two base jobs count; 3 base jobs in total.
  assert.deepEqual(computeProgress(list, 3, false), { completed: 2, total: 3, percent: 66.7, finished: false });
});

test("computeProgress handles not-started, finished and empty lists", () => {
  const list = jobs("base", "phantom");
  assert.equal(computeProgress(list, -1, true).completed, 0);
  assert.deepEqual(computeProgress(list, 2, false), { completed: 1, total: 1, percent: 100, finished: true });
  assert.deepEqual(computeProgress([], 0, true), { completed: 0, total: 0, percent: 0, finished: true });
});

test("describePhase: the current job is 'started' and finishing it starts the next", () => {
  const list = jobs("base", "base", "phantom");
  assert.deepEqual(describePhase(list, -1), { phase: "idle", current: null, next: list[0] });
  assert.deepEqual(describePhase(list, 0), { phase: "started", current: list[0], next: list[1] });
  assert.deepEqual(describePhase(list, 2), { phase: "started", current: list[2], next: null });
  assert.deepEqual(describePhase(list, 3), { phase: "finished", current: null, next: null });
  assert.deepEqual(describePhase([], -1), { phase: "idle", current: null, next: null });
});

test("finishing a job counts it as done and starts the next one", () => {
  const list = jobs("base", "base", "base", "base");
  const started = computeProgress(list, 1, true);
  assert.equal(started.completed, 1);
  // "Finish" = move to index + 1: the job just done is counted, the next is started.
  const afterFinish = computeProgress(list, 2, true);
  assert.equal(afterFinish.completed, 2);
  assert.equal(describePhase(list, 2).current, list[2]);
  // Finishing the last job completes the run.
  const last = computeProgress(list, 4, true);
  assert.deepEqual([last.completed, last.finished, describePhase(list, 4).phase], [4, true, "finished"]);
});
