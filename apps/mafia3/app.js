import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStoryTrackerApp, makeDayLocationCleaner, dayLocationMatchText } from "../_lib/storyTracker.js";
import { DEFAULT_CHAPTERS } from "./chapters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMafia3App() {
  return createStoryTrackerApp({
    publicDir: path.join(__dirname, "public"),
    envPrefix: "MAFIA3",
    dbTable: "mafia3_state",
    defaultChapters: DEFAULT_CHAPTERS,
    cleanChapter: makeDayLocationCleaner(),
    matchText: dayLocationMatchText
  });
}
