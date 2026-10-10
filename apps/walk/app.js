import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// "Gå gennem Danmark"-overlay. Skjult: ikke på forsiden, og kun monteret når
// WALK_PATH er sat til en hemmelig sti (12+ bogstaver/tal/-/_). Alle andre
// steder — også /walk — giver 404. Siden får noindex.
export function createWalkApp() {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "no-cache");
    next();
  });
  router.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
  return router;
}
