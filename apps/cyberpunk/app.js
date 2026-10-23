import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStoryTrackerApp } from "../_lib/storyTracker.js";
import { DEFAULT_QUESTS } from "./quests.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARTS = new Set(["base", "phantom"]);

// Stored in the shared tracker's { day, location, part } shape: day = job name,
// location = act label, part = "base" | "phantom".
export function cleanQuest(input) {
  const part = input?.part;
  return {
    id: (input && input.id) || crypto.randomUUID(),
    day: String((input && input.name) ?? (input && input.day) ?? "").trim().slice(0, 80),
    location: String((input && (input.act ?? input.location)) ?? "").trim().slice(0, 60),
    part: PARTS.has(part) ? part : "base"
  };
}

function questMatchText(quest) {
  return quest.day;
}

export function createCyberpunkApp() {
  return createStoryTrackerApp({
    publicDir: path.join(__dirname, "public"),
    envPrefix: "CYBERPUNK",
    dbTable: "cyberpunk_state",
    defaultChapters: DEFAULT_QUESTS,
    cleanChapter: cleanQuest,
    matchText: questMatchText
  });
}
