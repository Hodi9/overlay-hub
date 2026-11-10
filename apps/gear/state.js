import crypto from "node:crypto";

// The colour of the frame, the brand and the chat command. The colours themselves are in the overlay.
export const ACCENTS = ["orange", "lime", "mint", "blue", "violet", "yellow", "pink", "white"];
export const MAX_PRODUCTS = 12;
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;

const clip = (value, max) => String(value ?? "").trim().slice(0, max);
const between = (value, min, max, fallback) => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

// Everything around the products: the texts on the card, the shop it points to, and how often it comes up.
export const DEFAULT_PLAN = {
  eyebrow: "Jeg bruger",
  hint: "Skriv kommandoen i chatten for mere info",
  shop: "",
  outroEnabled: false,
  outroText: "",
  accent: "orange",
  scale: 1,
  showSeconds: 7,
  everyMinutes: 15,
  portrait: ""
};

// "portrait" is not set here: it is the version of an uploaded picture and only the server changes it.
export function cleanPlan(input, existing = DEFAULT_PLAN) {
  const text = (key, max) => (typeof input?.[key] === "string" ? clip(input[key], max) : existing[key]);
  return {
    eyebrow: text("eyebrow", 30),
    hint: text("hint", 70),
    shop: text("shop", 30),
    outroEnabled: typeof input?.outroEnabled === "boolean" ? input.outroEnabled : existing.outroEnabled,
    outroText: text("outroText", 120),
    accent: ACCENTS.includes(input?.accent) ? input.accent : existing.accent,
    scale: Math.round(between(input?.scale, SCALE_MIN, SCALE_MAX, existing.scale) * 100) / 100,
    showSeconds: Math.round(between(input?.showSeconds, 3, 30, existing.showSeconds)),
    everyMinutes: Math.round(between(input?.everyMinutes, 1, 180, existing.everyMinutes)),
    portrait: existing.portrait || ""
  };
}

// "!tastatur" from "Cepter Titan Pro gaming tastatur": the last word, without Danish letters.
export function commandFor(name) {
  const words = String(name || "").toLowerCase().replace(/[æ]/g, "ae").replace(/[ø]/g, "o").replace(/[å]/g, "a").split(/[^a-z0-9]+/).filter(Boolean);
  return "!" + (words.at(-1) || "gear").slice(0, 16);
}

// A chat command is one word that starts with "!". Anything else is tidied into that, or dropped.
export function cleanCommand(value) {
  const word = clip(value, 24).replace(/\s+/g, "").replace(/^!+/, "");
  return word ? "!" + word.slice(0, 20) : "";
}

const cleanUrl = (value) => (/^https?:\/\/\S+$/i.test(clip(value, 500)) ? clip(value, 500) : "");

export const blankProduct = (id = crypto.randomUUID()) => ({ id, brand: "", name: "", price: "", before: "", command: "", url: "", image: "" });

// Merges a patch into a product. An empty name keeps the old one; "image" is only changed by the server.
export function cleanProduct(input, existing = blankProduct()) {
  const text = (key, max) => (typeof input?.[key] === "string" ? clip(input[key], max) : existing[key]);
  const name = typeof input?.name === "string" ? clip(input.name, 80) : "";
  const product = {
    id: existing.id,
    brand: text("brand", 30),
    name: name || existing.name,
    price: text("price", 24),
    before: text("before", 24),
    command: typeof input?.command === "string" ? cleanCommand(input.command) : existing.command,
    url: typeof input?.url === "string" ? cleanUrl(input.url) : existing.url,
    image: existing.image || ""
  };
  if (!product.command && product.name) product.command = commandFor(product.name);
  return product;
}

export function addProduct(products, input) {
  const product = cleanProduct(input);
  if (!product.name || products.length >= MAX_PRODUCTS) return null;
  return { products: [...products, product], product };
}

export function updateProduct(products, id, patch) {
  const at = products.findIndex((product) => product.id === id);
  if (at === -1) return null;
  return products.map((product, i) => (i === at ? cleanProduct(patch, product) : product));
}

export const removeProduct = (products, id) => products.filter((product) => product.id !== id);

export function reorder(products, ids) {
  const byId = new Map(products.map((product) => [product.id, product]));
  const ordered = [...new Set(Array.isArray(ids) ? ids : [])].map((id) => byId.get(id)).filter(Boolean);
  for (const product of products) if (!ordered.includes(product)) ordered.push(product);
  return ordered;
}

// Reads what was saved in the database, tolerating anything that does not look right.
export function restore(saved) {
  const products = (Array.isArray(saved?.products) ? saved.products : [])
    .map((raw) => {
      const base = blankProduct(typeof raw?.id === "string" && raw.id ? raw.id.slice(0, 64) : undefined);
      return cleanProduct(raw, { ...base, image: typeof raw?.image === "string" ? raw.image.slice(0, 16) : "" });
    })
    .filter((product) => product.name)
    .slice(0, MAX_PRODUCTS);
  const portrait = typeof saved?.plan?.portrait === "string" ? saved.plan.portrait.slice(0, 16) : "";
  return { plan: cleanPlan(saved?.plan, { ...DEFAULT_PLAN, portrait }), products };
}
