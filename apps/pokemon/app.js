import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import seedCards from "./seed-30th.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLECTR_URL = "https://app.getcollectr.com/sets/category/3/30th-celebration?groupId=24722&cardType=cards&sortType=price&sortOrder=DESC";
const SETS = {
  "30th-celebration": { id: "30th-celebration", name: "30th Celebration", sourceUrl: COLLECTR_URL },
  "ascended-heroes": { id: "ascended-heroes", name: "Ascended Heroes", sourceUrl: "" }
};

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function decodeSerializedString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return String(value || "").replace(/\\u0026/g, "&").replace(/\\"/g, '"');
  }
}

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

export function parseCollectrCards(html) {
  const cards = [];
  const seen = new Set();
  const pattern = /\\"product_id\\":\\"(\d+)\\"[\s\S]*?\\"catalog_group_id\\":\\"24722\\"[\s\S]*?\\"product_name\\":\\"([\s\S]*?)\\"[\s\S]*?\\"image_url\\":\\"([\s\S]*?)\\"[\s\S]*?\\"card_number\\":\\"([\s\S]*?)\\"[\s\S]*?\\"rarity\\":\\"([\s\S]*?)\\"[\s\S]*?\\"product_sub_type\\":\\"([\s\S]*?)\\"[\s\S]*?\\"latest_price\\":\\"([\s\S]*?)\\"/g;
  let match;
  while ((match = pattern.exec(String(html || ""))) !== null) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    const latestPrice = decodeSerializedString(match[7]);
    cards.push({
      id: `collectr-${match[1]}`,
      sourceId: match[1],
      setId: "30th-celebration",
      name: decodeSerializedString(match[2]).trim(),
      image: decodeSerializedString(match[3]),
      number: decodeSerializedString(match[4]),
      rarity: decodeSerializedString(match[5]),
      finish: decodeSerializedString(match[6]),
      price: formatUsd(latestPrice),
      priceValue: Number(latestPrice) || 0,
      visible: true,
      source: "Collectr"
    });
  }
  return cards;
}

function cleanSetId(value) {
  return SETS[value] ? value : "30th-celebration";
}

function cleanCard(input, existing = {}) {
  const setId = cleanSetId(input?.setId || existing.setId);
  const name = String(input?.name ?? existing.name ?? "").trim().slice(0, 100);
  return {
    id: existing.id || crypto.randomUUID(),
    sourceId: existing.sourceId || null,
    setId,
    name,
    image: String(input?.image ?? existing.image ?? "").trim().slice(0, 1000),
    number: String(input?.number ?? existing.number ?? "").trim().slice(0, 30),
    rarity: String(input?.rarity ?? existing.rarity ?? "").trim().slice(0, 80),
    finish: String(input?.finish ?? existing.finish ?? "").trim().slice(0, 50),
    price: String(input?.price ?? existing.price ?? "").trim().slice(0, 40),
    priceValue: Number(input?.priceValue ?? existing.priceValue) || 0,
    visible: typeof input?.visible === "boolean" ? input.visible : existing.visible !== false,
    source: existing.source || "Manual"
  };
}

function mergeImportedCards(current, imported) {
  const bySource = new Map(current.filter((card) => card.sourceId).map((card) => [card.sourceId, card]));
  const otherCards = current.filter((card) => card.setId !== "30th-celebration" || !card.sourceId);
  const refreshed = imported.map((card) => {
    const existing = bySource.get(card.sourceId);
    return { ...card, visible: existing ? existing.visible !== false : true };
  });
  return [...otherCards, ...refreshed];
}

export function createPokemonApp(options = {}) {
  const router = express.Router();
  const controlPassword = options.controlPassword ?? process.env.POKEMON_CONTROL_PASSWORD ?? "";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const refreshIntervalMs = options.refreshIntervalMs ?? 15 * 60 * 1000;
  let cards = seedCards.map((card) => cleanCard(card, card));
  let lastSync = null;
  let lastSyncError = "";
  let db = null;

  function authorized(request) {
    if (!controlPassword) return false;
    return safeEqual(request.headers["x-pokemon-key"] || "", controlPassword);
  }

  function requireAuth(request, response, next) {
    if (!controlPassword) return response.status(503).json({ error: "Kontrolpanelets adgangskode er ikke konfigureret endnu." });
    if (authorized(request)) return next();
    return response.status(401).json({ error: "Forkert eller manglende adgangskode." });
  }

  async function connectDatabase() {
    if (!process.env.DATABASE_URL || options.disableDatabase) return;
    const { Pool } = pg;
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });
    await db.query(`
      CREATE TABLE IF NOT EXISTS pokemon_overlay_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await db.query("SELECT data FROM pokemon_overlay_state WHERE id = $1", ["primary"]);
    if (Array.isArray(result.rows[0]?.data?.cards)) {
      cards = result.rows[0].data.cards.map((card) => cleanCard(card, card));
      lastSync = result.rows[0].data.lastSync || null;
    } else {
      await persist();
    }
  }

  async function persist() {
    if (!db) return;
    await db.query(
      `INSERT INTO pokemon_overlay_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      ["primary", JSON.stringify({ cards, lastSync })]
    );
  }

  async function importCollectr() {
    if (typeof fetchImpl !== "function") throw new Error("Fetch er ikke tilgængelig.");
    const response = await fetchImpl(COLLECTR_URL, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; OverlayHub/1.0; +https://overlay-hub.onrender.com/)"
      }
    });
    if (!response.ok) throw new Error(`Collectr svarede med ${response.status}.`);
    const imported = parseCollectrCards(await response.text());
    if (!imported.length) throw new Error("Ingen kort kunne aflæses fra Collectr.");
    cards = mergeImportedCards(cards, imported);
    lastSync = new Date().toISOString();
    lastSyncError = "";
    await persist();
    return imported.length;
  }

  function payload(setId = "30th-celebration") {
    const selected = setId === "all" ? cards : cards.filter((card) => card.setId === cleanSetId(setId));
    return {
      cards: selected,
      sets: Object.values(SETS),
      selectedSet: setId === "all" ? "all" : cleanSetId(setId),
      lastSync,
      lastSyncError,
      passwordRequired: true,
      sourceUrl: COLLECTR_URL
    };
  }

  router.use(express.json({ limit: "64kb" }));

  router.get("/api/state", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(payload(String(request.query.set || "30th-celebration")));
  });

  router.post("/api/import/30th", requireAuth, async (_request, response, next) => {
    try {
      const imported = await importCollectr();
      response.json({ ...payload("30th-celebration"), imported });
    } catch (error) {
      lastSyncError = error.message;
      next(error);
    }
  });

  router.post("/api/cards", requireAuth, async (request, response, next) => {
    try {
      const card = cleanCard(request.body);
      if (!card.name) return response.status(400).json({ error: "Kortet skal have et navn." });
      cards.push(card);
      await persist();
      response.json(payload(card.setId));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/cards/:id", requireAuth, async (request, response, next) => {
    try {
      const index = cards.findIndex((card) => card.id === request.params.id);
      if (index === -1) return response.status(404).json({ error: "Kortet findes ikke." });
      cards[index] = cleanCard(request.body, cards[index]);
      await persist();
      response.json(payload(cards[index].setId));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/cards/:id", requireAuth, async (request, response, next) => {
    try {
      const existing = cards.find((card) => card.id === request.params.id);
      if (!existing) return response.status(404).json({ error: "Kortet findes ikke." });
      cards = cards.filter((card) => card.id !== request.params.id);
      await persist();
      response.json(payload(existing.setId));
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _request, response, _next) => {
    console.error("Pokemon overlay error", error);
    response.status(500).json({ error: error.message || "Pokémon-servicen kunne ikke udføre handlingen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  connectDatabase()
    .then(() => importCollectr())
    .catch((error) => {
      lastSyncError = error.message;
      console.error("Pokemon initialisation failed; using bundled cards.", error);
    });

  const refreshTimer = setInterval(() => {
    importCollectr().catch((error) => {
      lastSyncError = error.message;
      console.error("Pokemon Collectr refresh failed.", error);
    });
  }, refreshIntervalMs);
  refreshTimer.unref?.();

  return router;
}
