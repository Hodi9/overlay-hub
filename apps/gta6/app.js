import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStoryTrackerApp, makeDayLocationCleaner, dayLocationMatchText } from "../_lib/storyTracker.js";
import { DEFAULT_MISSIONS } from "./missions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createGta6App(extra = {}) {
  return createStoryTrackerApp({
    ...extra,
    publicDir: path.join(__dirname, "public"),
    envPrefix: "GTA6",
    dbTable: "gta6_state",
    defaultChapters: DEFAULT_MISSIONS,
    cleanChapter: makeDayLocationCleaner(),
    matchText: dayLocationMatchText
  });
}
