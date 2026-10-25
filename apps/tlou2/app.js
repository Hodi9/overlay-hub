import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStoryTrackerApp, makeDayLocationCleaner, dayLocationMatchText } from "../_lib/storyTracker.js";
import { DEFAULT_CHAPTERS } from "./chapters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createTlou2App(extra = {}) {
  return createStoryTrackerApp({
    ...extra,
    publicDir: path.join(__dirname, "public"),
    envPrefix: "TLOU2",
    dbTable: "tlou2_state",
    defaultChapters: DEFAULT_CHAPTERS,
    cleanChapter: makeDayLocationCleaner(),
    matchText: dayLocationMatchText
  });
}
