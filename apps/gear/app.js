import crypto from "node:crypto";
import express from "express";
import { Jimp } from "jimp";

const DEFAULT_OUTRO_TEXT = "Få mit gear og en masse andet lækkert inde på Power.dk";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CUTOUT_MAX_SIZE = 320;
const CUTOUT_THRESHOLD = 18;
const CUTOUT_FEATHER = 20;

const DEFAULT_PRODUCTS = [
  { brand: "CEPTER", name: "Cepter Titan Pro gaming tastatur", price: "1.298 kr.", before: "", command: "!keyboard", image: "assets/keyboard.png", url: "https://www.power.dk/gaming-og-underholdning/pc-og-tilbehoer/gaming-mus-og-tastatur/gaming-tastatur/cepter-titan-pro-gaming-tastatur/p-3826865/" },
  { brand: "LOGITECH", name: "Logitech G PRO X2 SUPERSTRIKE gaming mus", price: "1.399 kr.", before: "", command: "!mus", image: "assets/mouse.png", url: "https://www.power.dk/gaming-og-underholdning/pc-og-tilbehoer/gaming-mus-og-tastatur/gaming-mus/logitech-g-pro-x2-superstrike-traadloes-gaming-mus/p-4229653/" },
  { brand: "DJI", name: "DJI Osmo Pocket 3 Creator combo", price: "4.299 kr.", before: "", command: "!kamera", image: "assets/camera.png", url: "https://www.power.dk/mobil-og-foto/kameraer/actionkameraer/dji-osmo-pocket-3-creator-combo/p-2735028/" },
  { brand: "SAMSUNG", name: "Samsung Odyssey OLED G6 27” QHD gamingskærm", price: "3.999 kr.", before: "6.999 kr.", command: "!skærm", image: "assets/monitor.png", url: "https://www.power.dk/samsung-odyssey-oled-g6-s27dg602-27-qhd-gamingskaerm/p-3163099/" },
];

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function formatKr(n) {
  if (n == null || !Number.isFinite(n)) return "";
  return Math.round(n).toLocaleString("da-DK") + " kr.";
}

async function cutoutProductImage(imageUrl) {
  if (!imageUrl) return imageUrl;
  try {
    const res = await fetch(imageUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) return imageUrl;
    const buf = Buffer.from(await res.arrayBuffer());

    const img = await Jimp.read(buf);
    const { width, height } = img.bitmap;

    const cornerIdx = (2 * width + 2) * 4;
    const cr = img.bitmap.data[cornerIdx];
    const cg = img.bitmap.data[cornerIdx + 1];
    const cb = img.bitmap.data[cornerIdx + 2];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const r = img.bitmap.data[idx];
        const g = img.bitmap.data[idx + 1];
        const b = img.bitmap.data[idx + 2];
        const dist = Math.sqrt((r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2);

        if (dist < CUTOUT_THRESHOLD) {
          img.bitmap.data[idx + 3] = 0;
        } else if (dist < CUTOUT_THRESHOLD + CUTOUT_FEATHER) {
          const t = (dist - CUTOUT_THRESHOLD) / CUTOUT_FEATHER;
          img.bitmap.data[idx + 3] = Math.round(255 * t);
        }
      }
    }

    if (width > CUTOUT_MAX_SIZE || height > CUTOUT_MAX_SIZE) {
      img.resize({ w: CUTOUT_MAX_SIZE, h: CUTOUT_MAX_SIZE });
    }

    const outBuf = await img.getBuffer("image/png");
    return "data:image/png;base64," + outBuf.toString("base64");
  } catch (err) {
    console.error("gear: cutout failed, falling back to original image", err);
    return imageUrl;
  }
}

async function fetchProductFromPower(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("Kunne ikke hente siden (" + res.status + ")");
  const html = await res.text();

  const match = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Fandt ingen produktdata på den side");

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error("Kunne ikke læse produktdata fra siden");
  }

  const graph = Array.isArray(data["@graph"]) ? data["@graph"] : [data];
  const product = graph.find((g) => g["@type"] === "Product");
  if (!product) throw new Error("Fandt intet produkt på den side");

  const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;

  let originalPrice = null;
  if (offer && offer.priceSpecification && offer.priceSpecification.priceType === "StrikethroughPrice") {
    originalPrice = offer.priceSpecification.price != null ? Number(offer.priceSpecification.price) : null;
  }

  const rawImage = Array.isArray(product.image) ? product.image[0] : (product.image || "");
  const cutoutImage = await cutoutProductImage(rawImage);
  const price = offer && offer.price != null ? Number(offer.price) : null;

  return {
    brand: (product.brand && product.brand.name) || "",
    name: product.name || "",
    price: formatKr(price),
    before: formatKr(originalPrice),
    image: cutoutImage,
    url,
  };
}

function slugifyCommand(name) {
  const cleaned = String(name || "")
    .toLowerCase()
    .replace(/[æå]/g, "a")
    .replace(/ø/g, "o")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 16);
  return "!" + (cleaned || "gear");
}

export function createGearApp() {
  const router = express.Router();
  const controlPassword = process.env.GEAR_CONTROL_PASSWORD || "";

  const state = {
    outroEnabled: false,
    outroText: DEFAULT_OUTRO_TEXT,
    overlayScale: 1,
    products: DEFAULT_PRODUCTS.map((p) => ({ id: crypto.randomUUID(), image: "", ...p })),
  };

  function authorized(req) {
    if (!controlPassword) return true;
    const key = String(req.headers["x-gear-key"] || "");
    return safeEqual(key, controlPassword);
  }

  router.use(express.json());

  router.get("/api/config", (_req, res) => {
    res.json({
      outroEnabled: state.outroEnabled,
      outroText: state.outroText,
      overlayScale: state.overlayScale,
      passwordRequired: Boolean(controlPassword),
    });
  });

  router.post("/api/config", (req, res) => {
    if (!authorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = req.body || {};
    if (typeof body.outroEnabled === "boolean") state.outroEnabled = body.outroEnabled;
    if (typeof body.overlayScale === "number" && Number.isFinite(body.overlayScale)) {
      state.overlayScale = Math.min(1.6, Math.max(0.5, body.overlayScale));
    }
    if (typeof body.outroText === "string" && body.outroText.trim()) {
      state.outroText = body.outroText.trim();
    }
    res.json({
      outroEnabled: state.outroEnabled,
      outroText: state.outroText,
      overlayScale: state.overlayScale,
      passwordRequired: Boolean(controlPassword),
    });
  });

  router.get("/api/products", (_req, res) => {
    res.json(state.products);
  });

  router.post("/api/products", async (req, res) => {
    if (!authorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = req.body || {};

    if (body.id) {
      const product = state.products.find((p) => p.id === body.id);
      if (!product) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (typeof body.before === "string") product.before = body.before.trim();
      if (typeof body.price === "string" && body.price.trim()) product.price = body.price.trim();
      if (typeof body.command === "string" && body.command.trim()) product.command = body.command.trim();
      if (body.refresh) {
        try {
          const fresh = await fetchProductFromPower(product.url);
          Object.assign(product, fresh, { id: product.id, command: product.command });
        } catch (err) {
          res.status(422).json({ error: err.message || "Kunne ikke opdatere produktdata" });
          return;
        }
      }
      res.json(product);
      return;
    }

    const url = String(body.url || "").trim();
    if (!url) {
      res.status(400).json({ error: "url required" });
      return;
    }

    let fetched;
    try {
      fetched = await fetchProductFromPower(url);
    } catch (err) {
      res.status(422).json({ error: err.message || "Kunne ikke hente produktdata" });
      return;
    }

    const product = {
      id: crypto.randomUUID(),
      ...fetched,
      command: (typeof body.command === "string" && body.command.trim()) || slugifyCommand(fetched.name),
    };
    if (typeof body.before === "string" && body.before.trim()) product.before = body.before.trim();

    state.products.push(product);
    res.json(product);
  });

  router.delete("/api/products/:id", (req, res) => {
    if (!authorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    state.products = state.products.filter((p) => p.id !== req.params.id);
    res.json({ ok: true });
  });

  if (!controlPassword) {
    console.log("ADVARSEL: GEAR_CONTROL_PASSWORD er ikke sat — gear-panelet er ubeskyttet for alle med linket.");
  }

  return router;
}
