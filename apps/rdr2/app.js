import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStoryTrackerApp } from "../_lib/storyTracker.js";
import { DEFAULT_MISSIONS } from "./missions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function cleanMission(input) {
  return {
    id: (input && input.id) || crypto.randomUUID(),
    day: String((input && input.name) ?? (input && input.day) ?? "").trim().slice(0, 80),
    location: String((input && input.location) ?? "").trim().slice(0, 60),
    part: (input && (input.chapter ?? input.part)) || null
  };
}

// Save headers only contain the mission title, so match on that alone
// (chapter/location are display metadata, not part of the match).
function missionMatchText(mission) {
  return mission.day;
}

export function createRdr2App() {
  const router = createStoryTrackerApp({
    publicDir: path.join(__dirname, "public"),
    envPrefix: "RDR2",
    dbTable: "rdr2_state",
    defaultChapters: DEFAULT_MISSIONS.map((m) => ({ day: m.name, location: m.location, part: m.chapter })),
    cleanChapter: cleanMission,
    matchText: missionMatchText
  });
  return router;
}
