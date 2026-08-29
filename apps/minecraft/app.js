import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const widget = JSON.parse(fs.readFileSync(path.join(__dirname, "widget.json"), "utf8"));
const bossKeys = ["warden", "guardian", "wither", "dragon"];

function toBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function createMinecraftApp() {
  const router = express.Router();
  const controlPassword = process.env.MINECRAFT_CONTROL_PANEL_PASSWORD || "";
  const authSecret = process.env.MINECRAFT_AUTH_SECRET || "local-development-secret";

  const variableDefaults = Object.fromEntries(
    widget.variables.map((item) => [item.variableName, item.variableValue])
  );

  function initialState() {
    return {
      deaths: Math.max(0, Math.round(toNumber(variableDefaults.manualDeathCount, 0))),
      overlayScale: clamp(toNumber(variableDefaults.overlayScale, 0.8), 0.45, 1.6),
      showCross: toBool(variableDefaults.showCross, true),
      channelName: String(variableDefaults.channelName || ""),
      deathCommand: String(variableDefaults.deathCommand || "!death"),
      chatEnabled: toBool(variableDefaults.chatEnabled, true),
      modOnly: toBool(variableDefaults.modOnly, true),
      bosses: Object.fromEntries(
        bossKeys.map((key) => [
          key,
          {
            name: String(variableDefaults[`${key}Name`] || key.toUpperCase()),
            show: toBool(variableDefaults[`${key}Show`], true),
            defeated: toBool(variableDefaults[`${key}Defeated`], false)
          }
        ])
      ),
      updatedAt: new Date().toISOString()
    };
  }

  let state = initialState();
  let db = null;
  const listeners = new Set();

  function cleanState(input) {
    const base = initialState();
    const next = {
      ...base,
      ...input,
      deaths: Math.max(0, Math.round(toNumber(input?.deaths, base.deaths))),
      overlayScale: clamp(toNumber(input?.overlayScale, base.overlayScale), 0.45, 1.6),
      showCross: toBool(input?.showCross, base.showCross),
      chatEnabled: toBool(input?.chatEnabled, base.chatEnabled),
      modOnly: toBool(input?.modOnly, base.modOnly),
      channelName: String(input?.channelName ?? base.channelName).trim().slice(0, 40),
      deathCommand: String(input?.deathCommand ?? base.deathCommand).trim().slice(0, 40) || "!death",
      bosses: {}
    };

    for (const key of bossKeys) {
      const source = input?.bosses?.[key] || {};
      next.bosses[key] = {
        name: String(source.name ?? base.bosses[key].name).trim().slice(0, 32) || base.bosses[key].name,
        show: toBool(source.show, base.bosses[key].show),
        defeated: toBool(source.defeated, base.bosses[key].defeated)
      };
    }

    next.updatedAt = new Date().toISOString();
    return next;
  }

  async function connectDatabase() {
    if (!process.env.DATABASE_URL) return;
    const { Pool } = pg;
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
        ? false
        : { rejectUnauthorized: false }
    });

    await db.query(`
      CREATE TABLE IF NOT EXISTS minecraft_tracker_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const result = await db.query(
      "SELECT data FROM minecraft_tracker_state WHERE id = $1",
      ["primary"]
    );

    if (result.rows[0]?.data) {
      state = cleanState(result.rows[0].data);
    } else {
      await persistState();
    }
  }

  async function persistState() {
    if (!db) return;
    await db.query(
      `INSERT INTO minecraft_tracker_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      ["primary", JSON.stringify(state)]
    );
  }

  function broadcast() {
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const response of listeners) response.write(payload);
  }

  async function commitState(nextState) {
    state = cleanState(nextState);
    await persistState();
    broadcast();
    return state;
  }

  function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  function authToken() {
    return crypto.createHmac("sha256", authSecret).update("minecraft-control").digest("hex");
  }

  function parseCookies(request) {
    return Object.fromEntries(
      String(request.headers.cookie || "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const index = part.indexOf("=");
          return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
        })
    );
  }

  function authorized(request) {
    if (!controlPassword) return true;
    const cookies = parseCookies(request);
    const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const apiKey = String(request.headers["x-tracker-key"] || "");
    return safeEqual(cookies.tracker_auth || "", authToken())
      || safeEqual(bearer, controlPassword)
      || safeEqual(apiKey, controlPassword);
  }

  function requireAuth(request, response, next) {
    if (authorized(request)) return next();
    return response.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  function mergePatch(current, patch) {
    const next = structuredClone(current);
    const scalarKeys = [
      "deaths",
      "overlayScale",
      "showCross",
      "channelName",
      "deathCommand",
      "chatEnabled",
      "modOnly"
    ];
    for (const key of scalarKeys) {
      if (Object.hasOwn(patch, key)) next[key] = patch[key];
    }
    for (const key of bossKeys) {
      if (patch.bosses?.[key]) next.bosses[key] = { ...next.bosses[key], ...patch.bosses[key] };
    }
    return next;
  }

  function widgetVariables(current) {
    const values = {
      channelName: current.channelName,
      deathCommand: current.deathCommand,
      chatEnabled: current.chatEnabled,
      modOnly: current.modOnly,
      manualDeathCount: current.deaths,
      overlayScale: current.overlayScale,
      showCross: current.showCross
    };
    for (const key of bossKeys) {
      values[`${key}Name`] = current.bosses[key].name;
      values[`${key}Show`] = current.bosses[key].show;
      values[`${key}Defeated`] = current.bosses[key].defeated;
    }
    return values;
  }

  function replaceVariables(source, values) {
    return Object.entries(values).reduce((output, [name, value]) => {
      const escaped = JSON.stringify(String(value)).slice(1, -1);
      return output.split(`{${name}}`).join(escaped);
    }, source);
  }

  function overlayDocument() {
    const values = widgetVariables(state);
    const header = replaceVariables(widget.headerTag || "", values);
    const body = replaceVariables(widget.bodyTag || "", values);
    const style = replaceVariables(widget.styleTag || "", values);
    const script = replaceVariables(widget.scriptTag || "", values);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Minecraft Boss Tracker Overlay</title>
  ${header}
  <style>
    ${style}
    /* Keep visible bosses at their normal width when siblings are hidden. */
    .boss-card { flex: 0 1 calc((100% - 30px) / 4); }
  </style>
</head>
<body>
  ${body}
  <script>${script}</script>
  <script>
    (() => {
      let latest = null;
      const bossKeys = ${JSON.stringify(bossKeys)};
      function sync(next) {
        if (!next || typeof window.onLiveVariableUpdate !== "function") return;
        window.onLiveVariableUpdate("manualDeathCount", next.deaths);
        window.onLiveVariableUpdate("overlayScale", next.overlayScale);
        window.onLiveVariableUpdate("showCross", next.showCross);
        window.onLiveVariableUpdate("deathCommand", next.deathCommand);
        bossKeys.forEach((key) => {
          const boss = next.bosses[key];
          window.onLiveVariableUpdate(key + "Name", boss.name);
          window.onLiveVariableUpdate(key + "Show", boss.show);
          window.onLiveVariableUpdate(key + "Defeated", boss.defeated);
        });
        latest = next;
      }
      fetch("/minecraft/api/state", { cache: "no-store" }).then((r) => r.json()).then(sync).catch(() => {});
      const events = new EventSource("/minecraft/api/events");
      events.onmessage = (event) => {
        try { sync(JSON.parse(event.data)); } catch (_) {}
      };
      window.__trackerLatestState = () => latest;
    })();
  </script>
</body>
</html>`;
  }

  router.use(express.json({ limit: "64kb" }));
  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  router.get("/overlay", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.type("html").send(overlayDocument());
  });

  router.get("/control", (_request, response) => {
    response.sendFile(path.join(__dirname, "public", "control.html"));
  });

  router.get("/api/state", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(state);
  });

  router.get("/api/session", (request, response) => {
    response.json({ authenticated: authorized(request), passwordRequired: Boolean(controlPassword) });
  });

  router.post("/api/login", (request, response) => {
    if (controlPassword && !safeEqual(request.body?.password || "", controlPassword)) {
      return response.status(401).json({ error: "Forkert adgangskode." });
    }
    response.cookie("tracker_auth", authToken(), {
      path: "/minecraft",
      httpOnly: true,
      sameSite: "strict",
      secure: request.secure || request.headers["x-forwarded-proto"] === "https",
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    return response.json({ ok: true });
  });

  router.post("/api/logout", (_request, response) => {
    response.clearCookie("tracker_auth", { path: "/minecraft" });
    response.json({ ok: true });
  });

  router.patch("/api/state", requireAuth, async (request, response, next) => {
    try {
      const nextState = mergePatch(state, request.body || {});
      response.json(await commitState(nextState));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/event", requireAuth, async (request, response, next) => {
    try {
      const eventType = String(request.body?.type || "");
      const nextState = structuredClone(state);
      if (eventType === "death") {
        nextState.deaths += 1;
      } else if (eventType === "boss_defeated" || eventType === "boss_revived") {
        const boss = String(request.body?.boss || "").toLowerCase();
        if (!bossKeys.includes(boss)) return response.status(400).json({ error: "Ukendt boss." });
        nextState.bosses[boss].defeated = eventType === "boss_defeated";
      } else if (eventType === "reset") {
        Object.assign(nextState, initialState());
      } else {
        return response.status(400).json({ error: "Ukendt event-type." });
      }
      response.json(await commitState(nextState));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/events", (request, response) => {
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.flushHeaders();
    listeners.add(response);
    response.write(`data: ${JSON.stringify(state)}\n\n`);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20000);
    request.on("close", () => {
      clearInterval(keepAlive);
      listeners.delete(response);
    });
  });

  router.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "Tracker-servicen kunne ikke gemme ændringen." });
  });

  connectDatabase().catch((error) => {
    console.error("Database connection failed; using temporary in-memory state.", error);
  });

  return router;
}
