import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { DEFAULT_PLAN, MAX_PRODUCTS, addProduct, cleanPlan, removeProduct, reorder, restore, updateProduct } from "./state.js";
import { fetchProduct as fetchFromShop } from "./fetchProduct.js";
import { imageFromBuffer, imageFromDataUrl, packImages, sendImage, unpackImages } from "../_lib/images.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Gear-overlay: viser streamerens udstyr ét produkt ad gangen (mærke, navn, pris og chat-kommando) og gentager
// rækken med et fast mellemrum. Overlayet ligger på /gear/ og panelet på /gear/control.html.
// With a channel context (?profile=<id>) the app keeps one list per channel and checks that channel's keys.
export function createGearApp(context = {}) {
  const router = express.Router();
  const controlPassword = process.env.GEAR_CONTROL_PASSWORD || "";
  const stateId = context.stateId || "primary";
  const isChannel = Boolean(context.authorizeControl);
  const fetchProduct = context.fetchProduct || fetchFromShop;
  let plan = { ...DEFAULT_PLAN };
  let products = [];
  let images = new Map(); // product id (or "portrait") -> picture
  let db = context.pool || null;
  const listeners = new Set();

  const requireAuth = (req, res, next) => {
    const ok = isChannel ? context.authorizeControl(req) : !controlPassword || safeEqual(req.headers["x-gear-key"] || "", controlPassword);
    if (ok) return next();
    res.status(401).json({ error: "Forkert eller manglende adgangskode." });
  };

  const ready = (async () => {
    if (!db) return;
    await db.query(`CREATE TABLE IF NOT EXISTS gear_state (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const { rows } = await db.query("SELECT data FROM gear_state WHERE id = $1", [stateId]);
    if (!rows[0]) return;
    ({ plan, products } = restore(rows[0].data));
    images = unpackImages(rows[0].data?.images);
  })().catch((error) => {
    console.error("gear: database unavailable; using in-memory state.", error);
    db = null;
  });
  router.ready = ready;

  const payload = () => ({ plan, products, passwordRequired: !isChannel && Boolean(controlPassword) });
  const send = (text) => { for (const response of listeners) response.write(text); };

  function commit() {
    db?.query(
      `INSERT INTO gear_state (id, data, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [stateId, JSON.stringify({ plan, products, images: packImages(images) })]
    ).catch((error) => console.error("gear: could not save state.", error));
    send(`data: ${JSON.stringify(payload())}\n\n`);
    return payload();
  }

  // Puts a picture on a product (or takes it off with null) and writes its version into the product.
  function setProductImage(id, image) {
    if (image) images.set(id, image); else images.delete(id);
    products = products.map((product) => (product.id === id ? { ...product, image: image ? image.version : "" } : product));
  }

  router.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (req.path.startsWith("/api/") && !req.path.startsWith("/api/image/")) res.setHeader("Cache-Control", "no-store");
    // Ingen læsning eller ændring, før gemt tilstand er hentet — ellers kunne en tidlig ændring blive overskrevet.
    ready.then(() => next(), next);
  });
  router.use(express.json({ limit: "700kb" }));

  router.get("/api/state", (_req, res) => res.json(payload()));

  router.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.flushHeaders();
    listeners.add(res);
    res.write(`data: ${JSON.stringify(payload())}\n\n`);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20000);
    req.on("close", () => {
      clearInterval(keepAlive);
      listeners.delete(res);
    });
  });

  router.get("/api/image/:id", (req, res) => sendImage(images, req.params.id, res));

  // Panelet bruger den til at tjekke koden, før den gemmes.
  router.post("/api/login", requireAuth, (_req, res) => res.json({ ok: true }));

  router.patch("/api/plan", requireAuth, (req, res) => {
    plan = cleanPlan(req.body, plan);
    res.json(commit());
  });

  // Billedet af streameren i venstre side af kortet. En tom værdi fjerner det.
  router.put("/api/portrait", requireAuth, (req, res) => {
    const image = req.body?.dataUrl ? imageFromDataUrl(req.body.dataUrl) : null;
    if (req.body?.dataUrl && !image) return res.status(400).json({ error: "Billedet kunne ikke bruges. Vælg en PNG, JPG eller WebP." });
    if (image) images.set("portrait", image); else images.delete("portrait");
    plan = { ...plan, portrait: image ? image.version : "" };
    res.json(commit());
  });

  // Vis rækken nu i stedet for at vente på næste runde.
  router.post("/api/play", requireAuth, (_req, res) => {
    send(`event: play\ndata: {}\n\n`);
    res.json({ ok: true });
  });

  // Et nyt produkt: enten skrevet ind (name …) eller hentet fra et link til en butik (kun url).
  router.post("/api/products", requireAuth, async (req, res) => {
    if (products.length >= MAX_PRODUCTS) return res.status(400).json({ error: `Listen er fuld (${MAX_PRODUCTS}). Fjern et produkt først.` });
    const body = req.body || {};
    let fields = body;
    let picture = null;
    if (!String(body.name || "").trim() && body.url) {
      try {
        const fetched = await fetchProduct(String(body.url).trim());
        picture = fetched.picture;
        fields = { ...fetched, command: body.command };
      } catch (error) {
        return res.status(422).json({ error: error.message || "Kunne ikke hente produktet." });
      }
    }
    const added = addProduct(products, fields);
    if (!added) return res.status(400).json({ error: "Skriv et navn, eller indsæt et link til produktet." });
    products = added.products;
    if (picture) setProductImage(added.product.id, imageFromBuffer(picture, "image/png"));
    res.json(commit());
  });

  router.patch("/api/products/:id", requireAuth, async (req, res) => {
    const id = req.params.id;
    const current = products.find((product) => product.id === id);
    if (!current) return res.status(404).json({ error: "Produktet findes ikke." });
    let patch = req.body || {};
    // "Opdatér fra link": hent pris og billede igen, men behold kommandoen.
    if (patch.refresh) {
      if (!current.url) return res.status(400).json({ error: "Produktet har ikke noget link at hente fra." });
      try {
        const fetched = await fetchProduct(current.url);
        patch = { brand: fetched.brand, name: fetched.name, price: fetched.price, before: fetched.before };
        if (products.some((product) => product.id === id) && fetched.picture) setProductImage(id, imageFromBuffer(fetched.picture, "image/png"));
      } catch (error) {
        return res.status(422).json({ error: error.message || "Kunne ikke opdatere produktet." });
      }
    }
    const next = updateProduct(products, id, patch);
    if (!next) return res.status(404).json({ error: "Produktet findes ikke." });
    products = next;
    res.json(commit());
  });

  router.put("/api/products/:id/image", requireAuth, (req, res) => {
    if (!products.some((product) => product.id === req.params.id)) return res.status(404).json({ error: "Produktet findes ikke." });
    const image = req.body?.dataUrl ? imageFromDataUrl(req.body.dataUrl) : null;
    if (req.body?.dataUrl && !image) return res.status(400).json({ error: "Billedet kunne ikke bruges. Vælg en PNG, JPG eller WebP." });
    setProductImage(req.params.id, image);
    res.json(commit());
  });

  router.delete("/api/products/:id", requireAuth, (req, res) => {
    products = removeProduct(products, req.params.id);
    images.delete(req.params.id);
    res.json(commit());
  });

  router.put("/api/order", requireAuth, (req, res) => {
    products = reorder(products, req.body?.ids);
    res.json(commit());
  });

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Billedet er for stort." });
    console.error("gear:", error);
    res.status(error.status || 500).json({ error: "Gear-listen kunne ikke gemme ændringen." });
  });

  router.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  if (!isChannel && !controlPassword) console.log("ADVARSEL: GEAR_CONTROL_PASSWORD er ikke sat — gear-panelet er ubeskyttet for alle med linket.");

  return router;
}
