import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStoryTrackerApp } from "../_lib/storyTracker.js";
import { DEFAULT_MISSIONS } from "./missions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHARACTERS = new Set(["michael", "franklin", "trevor"]);

function cleanMission(input) {
  return {
    id: (input && input.id) || crypto.randomUUID(),
    day: String((input && input.name) ?? (input && input.day) ?? "").trim().slice(0, 80),
    location: "",
    part: CHARACTERS.has(input?.character ?? input?.part) ? (input.character ?? input.part) : null
  };
}

function missionMatchText(mission) {
  return mission.day;
}

export function createGta5App() {
  const router = createStoryTrackerApp({
    publicDir: path.join(__dirname, "public"),
    envPrefix: "GTA5",
    dbTable: "gta5_state",
    defaultChapters: DEFAULT_MISSIONS.map((m) => ({ day: m.name, part: m.character })),
    cleanChapter: cleanMission,
    matchText: missionMatchText
  });
  return router;
}
