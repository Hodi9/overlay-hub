import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import seedCards from "./seed-30th.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLECTR_URL = "https://app.getcollectr.com/sets/category/3/30th-celebration?groupId=24722&cardType=cards&sortType=price&sortOrder=DESC";
const CLASSIC_COLLECTR_URL = "https://app.getcollectr.com/sets/category/3/30th-celebration-classic-collection?groupId=24837&cardType=cards&sortType=price&sortOrder=DESC";
const CARDMARKET_URL = "https://www.cardmarket.com/en/Pokemon/Products/Singles/30th-Celebration";
const TCGGRAPH_URL = "https://api.tcggraph.com/v1/cards?game=pokemon&set=30th%20Celebration&source=cardmarket&sort=-price&limit=30&language=en";
export const CLASSIC_CHASE_CARDS = [
  { id: "classic-714386", sourceId: "classic:714386", setId: "30th-celebration", name: "Lugia", image: "https://public.getcollectr.com/public-assets/products/product_714386.jpg?optimizer=image&format=webp&width=1200&quality=80&strip=metadata", number: "149/147", rarity: "Classic Collection", finish: "Holofoil", price: "$1,280.49", priceValue: 1280.49, kind: "chase", visible: true, source: "Collectr" },
  { id: "classic-716198", sourceId: "classic:716198", setId: "30th-celebration", name: "Gengar (Prime)", image: "https://public.getcollectr.com/public-assets/products/product_716198.jpg?optimizer=image&format=webp&width=1200&quality=80&strip=metadata", number: "94/102", rarity: "Classic Collection", finish: "Holofoil", price: "$989.99", priceValue: 989.99, kind: "chase", visible: true, source: "Collectr" },
  { id: "classic-716160", sourceId: "classic:716160", setId: "30th-celebration", name: "Dark Tyranitar", image: "https://public.getcollectr.com/public-assets/products/product_716160.jpg?optimizer=image&format=webp&width=1200&quality=80&strip=metadata", number: "19/109", rarity: "Classic Collection", finish: "Holofoil", price: "$590.99", priceValue: 590.99, kind: "chase", visible: true, source: "Collectr" },
  { id: "classic-716210", sourceId: "classic:716210", setId: "30th-celebration", name: "Magikarp", image: "https://public.getcollectr.com/public-assets/products/product_716210.jpg?optimizer=image&format=webp&width=1200&quality=80&strip=metadata", number: "203/193", rarity: "Classic Collection", finish: "Holofoil", price: "$581.14", priceValue: 581.14, kind: "chase", visible: true, source: "Collectr" },
  { id: "classic-714372", sourceId: "classic:714372", setId: "30th-celebration", name: "Charizard", image: "https://public.getcollectr.com/public-assets/products/product_714372.jpg?optimizer=image&format=webp&width=1200&quality=80&strip=metadata", number: "4/102", rarity: "Classic Collection", finish: "Holofoil", price: "$495.00", priceValue: 495, kind: "chase", visible: true, source: "Collectr" }
];
export const RGB_MEW_CARDS = [
  {
    id: "featured-rgb-mew-red",
    setId: "30th-celebration",
    name: "Mew (Red)",
    image: "https://billsarchive.com/assets/articles/rgb-mew-red.webp",
    number: "R/RGB",
    rarity: "RGB Secret Rare",
    finish: "Foil",
    kind: "chase",
    featured: true,
    visible: true,
    source: "30th Celebration RGB"
  },
  {
    id: "featured-rgb-mew-green",
    setId: "30th-celebration",
    name: "Mew (Green)",
    image: "https://billsarchive.com/assets/articles/rgb-mew-green.webp",
    number: "G/RGB",
    rarity: "RGB Secret Rare",
    finish: "Foil",
    kind: "chase",
    featured: true,
    visible: true,
    source: "30th Celebration RGB"
  },
  {
    id: "featured-rgb-mew-blue",
    setId: "30th-celebration",
    name: "Mew (Blue)",
    image: "https://billsarchive.com/assets/articles/rgb-mew-blue.webp",
    number: "B/RGB",
    rarity: "RGB Secret Rare",
    finish: "Foil",
    kind: "chase",
    featured: true,
    visible: true,
    source: "30th Celebration RGB"
  }
];
const SETS = {
  "30th-celebration": { id: "30th-celebration", name: "30th Celebration", sourceUrl: CARDMARKET_URL },
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

function formatEur(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return new Intl.NumberFormat("da-DK", { style: "currency", currency: "EUR" }).format(amount);
}

function imageUrl(images) {
  const candidate = images?.large || images?.normal || images?.small || "";
  if (typeof candidate === "string") return candidate;
  return candidate?.webp || candidate?.avif || candidate?.url || "";
}

export function parseTcgGraphCards(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  return data
    .map((card) => {
      const quote = (Array.isArray(card?.prices) ? card.prices : [])
        .filter((price) => price?.source === "cardmarket" && price?.currency === "EUR")
        .filter((price) => Number.isFinite(Number(price?.market ?? price?.trend)))
        .sort((a, b) => Number(b.market ?? b.trend) - Number(a.market ?? a.trend))[0];
      if (!quote) return null;
      const priceValue = Number(quote.market ?? quote.trend);
      return {
        id: `tcggraph-${card.id}`,
        sourceId: `tcggraph:${card.id}`,
        setId: "30th-celebration",
        name: String(card.name || "").trim(),
        image: imageUrl(card.images),
        number: String(card.collectorNumber || ""),
        rarity: String(card.rarity || ""),
        finish: String(quote.finish || ""),
        price: formatEur(priceValue),
        priceValue,
        kind: "chase",
        visible: true,
        source: "Cardmarket"
      };
    })
    .filter((card) => card?.name)
    .sort((a, b) => b.priceValue - a.priceValue)
    .slice(0, 30);
}

export function parseCollectrCards(html, options = {}) {
  const cards = [];
  const seen = new Set();
  const groupId = String(options.groupId || "24722");
  const idPrefix = String(options.idPrefix || "collectr");
  const sourcePrefix = String(options.sourcePrefix || "");
  const pattern = /\\"product_id\\":\\"(\d+)\\"[\s\S]*?\\"catalog_group_id\\":\\"(\d+)\\"[\s\S]*?\\"product_name\\":\\"([\s\S]*?)\\"[\s\S]*?\\"image_url\\":\\"([\s\S]*?)\\"[\s\S]*?\\"card_number\\":\\"([\s\S]*?)\\"[\s\S]*?\\"rarity\\":\\"([\s\S]*?)\\"[\s\S]*?\\"product_sub_type\\":\\"([\s\S]*?)\\"[\s\S]*?\\"latest_price\\":\\"([\s\S]*?)\\"/g;
  let match;
  while ((match = pattern.exec(String(html || ""))) !== null) {
    if (match[2] !== groupId) continue;
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    const latestPrice = decodeSerializedString(match[8]);
    cards.push({
      id: `${idPrefix}-${match[1]}`,
      sourceId: `${sourcePrefix}${match[1]}`,
      setId: "30th-celebration",
      name: decodeSerializedString(match[3]).trim(),
      image: decodeSerializedString(match[4]),
      number: decodeSerializedString(match[5]),
      rarity: decodeSerializedString(match[6]),
      finish: decodeSerializedString(match[7]),
      price: formatUsd(latestPrice),
      priceValue: Number(latestPrice) || 0,
      kind: "chase",
      visible: true,
      source: "Collectr"
    });
  }
  return cards;
}

export function curateChaseCards(mainCards, classicCards) {
  const wantedClassicIds = new Set(CLASSIC_CHASE_CARDS.map((card) => card.sourceId));
  const parsedClassic = new Map(classicCards.map((card) => [card.sourceId, card]));
  const requiredClassic = CLASSIC_CHASE_CARDS.map((fallback) => parsedClassic.get(fallback.sourceId) || fallback);
  const eligibleMain = mainCards
    .filter((card) => !(card.name === "Greninja ex" && /^0?21(?:\/|$)/.test(card.number)))
    .sort((a, b) => b.priceValue - a.priceValue)
    .filter((card) => !wantedClassicIds.has(card.sourceId));
  const mainSlots = Math.max(0, 30 - RGB_MEW_CARDS.length - requiredClassic.length);
  return [...requiredClassic, ...eligibleMain.slice(0, mainSlots)].sort((a, b) => b.priceValue - a.priceValue);
}

function cleanSetId(value) {
  return SETS[value] ? value : "30th-celebration";
}

function cleanCard(input, existing = {}) {
  const setId = cleanSetId(input?.setId || existing.setId);
  const name = String(input?.name ?? existing.name ?? "").trim().slice(0, 100);
  const requestedKind = input?.kind || existing.kind || (input?.sourceId || existing.sourceId ? "chase" : "pull");
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
    kind: requestedKind === "chase" ? "chase" : "pull",
    featured: Boolean(input?.featured ?? existing.featured),
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
  const tcgGraphKey = options.tcgGraphKey ?? process.env.TCGGRAPH_KEY ?? "";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const refreshIntervalMs = options.refreshIntervalMs ?? 6 * 60 * 60 * 1000;
  let cards = [...RGB_MEW_CARDS, ...curateChaseCards(seedCards, CLASSIC_CHASE_CARDS)].map((card) => cleanCard(card, card));
  let settings = { showPrices: false };
  let lastSync = null;
  let lastSyncError = "";
  let lastSyncSource = tcgGraphKey ? "Cardmarket" : "Collectr fallback";
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

  function ensureFeaturedCards() {
    const missing = RGB_MEW_CARDS.filter((featuredCard) => !cards.some((card) => card.id === featuredCard.id));
    if (!missing.length) return false;
    cards = [...missing.map((card) => cleanCard(card, card)), ...cards];
    return true;
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
      lastSyncSource = result.rows[0].data.lastSyncSource || lastSyncSource;
      settings.showPrices = result.rows[0].data.settings?.showPrices === true;
      if (ensureFeaturedCards()) await persist();
    } else {
      ensureFeaturedCards();
      await persist();
    }
  }

  async function persist() {
    if (!db) return;
    await db.query(
      `INSERT INTO pokemon_overlay_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      ["primary", JSON.stringify({ cards, settings, lastSync, lastSyncSource })]
    );
  }

  async function importCollectr() {
    if (typeof fetchImpl !== "function") throw new Error("Fetch er ikke tilgængelig.");
    const requestOptions = {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; OverlayHub/1.0; +https://overlay-hub.onrender.com/)"
      }
    };
    const [mainResponse, classicResponse] = await Promise.all([
      fetchImpl(COLLECTR_URL, requestOptions),
      fetchImpl(CLASSIC_COLLECTR_URL, requestOptions)
    ]);
    if (!mainResponse.ok || !classicResponse.ok) {
      throw new Error(`Collectr svarede med ${mainResponse.ok ? classicResponse.status : mainResponse.status}.`);
    }
    const mainCards = parseCollectrCards(await mainResponse.text());
    const classicCards = parseCollectrCards(await classicResponse.text(), { groupId: "24837", idPrefix: "classic", sourcePrefix: "classic:" });
    const imported = curateChaseCards(mainCards, classicCards);
    if (imported.length < 27) throw new Error("Den kuraterede top 30 kunne ikke aflæses fra Collectr.");
    cards = mergeImportedCards(cards, imported);
    lastSync = new Date().toISOString();
    lastSyncSource = "Collectr fallback";
    lastSyncError = "";
    await persist();
    return imported.length + RGB_MEW_CARDS.length;
  }

  async function importCardmarket() {
    if (!tcgGraphKey) return importCollectr();
    if (typeof fetchImpl !== "function") throw new Error("Fetch er ikke tilgængelig.");
    const [response, classicResponse] = await Promise.all([
      fetchImpl(TCGGRAPH_URL, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${tcgGraphKey}`
        }
      }),
      fetchImpl(CLASSIC_COLLECTR_URL, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 (compatible; OverlayHub/1.0; +https://overlay-hub.onrender.com/)"
        }
      })
    ]);
    if (!response.ok) throw new Error(`Cardmarket-priskilden svarede med ${response.status}.`);
    const body = await response.json();
    if (body?.meta?.priceSource && body.meta.priceSource !== "cardmarket") {
      throw new Error("Priskilden returnerede ikke Cardmarket-priser.");
    }
    const mainCards = parseTcgGraphCards(body);
    const classicCards = classicResponse.ok
      ? parseCollectrCards(await classicResponse.text(), { groupId: "24837", idPrefix: "classic", sourcePrefix: "classic:" })
      : CLASSIC_CHASE_CARDS;
    const imported = curateChaseCards(mainCards, classicCards);
    if (imported.length < 27) throw new Error("Ingen komplet top 30 kunne aflæses for 30th Celebration.");
    cards = mergeImportedCards(cards, imported);
    lastSync = new Date().toISOString();
    lastSyncSource = "Cardmarket";
    lastSyncError = "";
    await persist();
    return imported.length + RGB_MEW_CARDS.length;
  }

  function payload(setId = "30th-celebration", view = "chase") {
    const bySet = setId === "all" ? cards : cards.filter((card) => card.setId === cleanSetId(setId));
    const selectedView = ["pulls", "chase", "all"].includes(view) ? view : "chase";
    const selected = selectedView === "all"
      ? bySet
      : bySet.filter((card) => card.kind === (selectedView === "pulls" ? "pull" : "chase"));
    return {
      cards: selected,
      sets: Object.values(SETS),
      selectedSet: setId === "all" ? "all" : cleanSetId(setId),
      selectedView,
      lastSync,
      lastSyncError,
      lastSyncSource,
      cardmarketEnabled: Boolean(tcgGraphKey),
      persistentStorage: Boolean(db),
      settings,
      passwordRequired: true,
      sourceUrl: tcgGraphKey ? CARDMARKET_URL : COLLECTR_URL
    };
  }

  router.use(express.json({ limit: "64kb" }));

  router.get("/api/state", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(payload(String(request.query.set || "30th-celebration"), String(request.query.view || "chase")));
  });

  router.post("/api/import/30th", requireAuth, async (_request, response, next) => {
    try {
      const imported = await importCardmarket();
      response.json({ ...payload("30th-celebration", "chase"), imported });
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
      response.json(payload(card.setId, card.kind === "pull" ? "pulls" : "chase"));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/settings", requireAuth, async (request, response, next) => {
    try {
      if (typeof request.body?.showPrices !== "boolean") {
        return response.status(400).json({ error: "showPrices skal være true eller false." });
      }
      settings = { ...settings, showPrices: request.body.showPrices };
      await persist();
      response.json(payload("all", "all"));
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
      response.json(payload(cards[index].setId, cards[index].kind === "pull" ? "pulls" : "chase"));
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
      response.json(payload(existing.setId, existing.kind === "pull" ? "pulls" : "chase"));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/cards/:id/hit", requireAuth, async (request, response, next) => {
    try {
      const chaseCard = cards.find((card) => card.id === request.params.id && card.kind === "chase");
      if (!chaseCard) return response.status(404).json({ error: "Chase-kortet findes ikke." });
      const pull = cleanCard({ ...chaseCard, id: undefined, sourceId: null, kind: "pull", visible: true }, {});
      pull.source = "Ramt fra chase list";
      cards.push(pull);
      await persist();
      response.json(payload("all", "pulls"));
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
    .then(() => importCardmarket())
    .catch((error) => {
      lastSyncError = error.message;
      console.error("Pokemon initialisation failed; using bundled cards.", error);
    });

  const refreshTimer = setInterval(() => {
    importCardmarket().catch((error) => {
      lastSyncError = error.message;
      console.error("Pokemon price refresh failed.", error);
    });
  }, refreshIntervalMs);
  refreshTimer.unref?.();

  return router;
}
