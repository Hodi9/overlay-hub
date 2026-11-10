import dns from "node:dns/promises";
import net from "node:net";
import { Jimp } from "jimp";

// Reads a product (brand, name, price, picture) from a shop's product page, so it does not have to be typed in.
// Most shops put the product on the page as schema.org data (JSON-LD); where they do not, the page's
// share title and picture are used and the price is typed by hand.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_PICTURE_BYTES = 6 * 1024 * 1024;
const CUTOUT_MAX_SIZE = 320;
const CUTOUT_THRESHOLD = 18;
const CUTOUT_FEATHER = 20;

// The panel makes this server fetch an address somebody typed, so addresses on the server's own
// network (localhost, 10.x, 192.168.x, cloud metadata on 169.254.x …) are refused.
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:");
  }
  return true;
}

async function assertPublic(url) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Linket skal starte med https://");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Den adresse kan ikke hentes.");
}

// fetch that checks every address on the way (also after a redirect) and stops at a size limit.
async function fetchPublic(address, { maxBytes, accept, lookup = assertPublic }) {
  let url = new URL(address);
  for (let hop = 0; hop < 5; hop++) {
    await lookup(url);
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000), headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "da,en;q=0.8" } });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = new URL(response.headers.get("location"), url);
      continue;
    }
    if (!response.ok) throw new Error(`Kunne ikke hente siden (${response.status}).`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error("Siden er for stor.");
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), type: String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(), url };
  }
  throw new Error("For mange omdirigeringer.");
}

const CURRENCY = { DKK: (n) => `${n} kr.`, SEK: (n) => `${n} kr.`, NOK: (n) => `${n} kr.`, EUR: (n) => `${n} €`, USD: (n) => `$${n}`, GBP: (n) => `£${n}` };

export function formatPrice(value, currency = "DKK") {
  const number = typeof value === "string" ? Number(value.replace(",", ".")) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return "";
  const text = (Number.isInteger(number) ? number : Math.round(number * 100) / 100).toLocaleString("da-DK", { minimumFractionDigits: Number.isInteger(number) ? 0 : 2, maximumFractionDigits: 2 });
  return (CURRENCY[String(currency || "DKK").toUpperCase()] || ((n) => `${n} ${String(currency).toUpperCase().slice(0, 3)}`))(text);
}

const decode = (text) => String(text || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)));

function meta(html, property) {
  const tag = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, "i").exec(html)?.[0];
  return tag ? decode(/content=["']([^"']*)["']/i.exec(tag)?.[1] || "").trim() : "";
}

const isType = (node, type) => [].concat(node?.["@type"] || []).includes(type);

// Every object in the page's JSON-LD, however deep it is nested.
function* nodes(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return;
  if (Array.isArray(value)) { for (const item of value) yield* nodes(item, depth + 1); return; }
  yield value;
  for (const key of ["@graph", "mainEntity", "itemListElement", "item"]) if (value[key]) yield* nodes(value[key], depth + 1);
}

// { brand, name, price, before, imageUrl } from a product page's HTML. Throws when the page is not about a product.
export function parseProductPage(html, pageUrl) {
  let product = null;
  for (const [, json] of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(json.trim()); } catch { continue; }
    for (const node of nodes(data)) if (isType(node, "Product")) { product = node; break; }
    if (product) break;
  }

  const absolute = (value) => { try { return value ? new URL(value, pageUrl).href : ""; } catch { return ""; } };
  const picture = (value) => { const first = [].concat(value || [])[0]; return typeof first === "string" ? first : first?.url || first?.contentUrl || ""; };

  if (!product) {
    const name = meta(html, "og:title") || decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || "").trim();
    if (!name) throw new Error("Fandt intet produkt på den side. Skriv det ind i hånden i stedet.");
    return { brand: "", name, price: formatPrice(meta(html, "product:price:amount"), meta(html, "product:price:currency") || "DKK"), before: "", imageUrl: absolute(meta(html, "og:image")) };
  }

  const offer = [].concat(product.offers || [])[0] || {};
  const currency = offer.priceCurrency || "DKK";
  const spec = [].concat(offer.priceSpecification || []).find((entry) => /StrikethroughPrice|ListPrice/i.test(String(entry?.priceType || "")));
  const brand = typeof product.brand === "string" ? product.brand : product.brand?.name || "";
  return {
    brand: decode(brand).trim(),
    name: decode(product.name || meta(html, "og:title")).trim(),
    price: formatPrice(offer.price ?? offer.lowPrice, currency),
    before: spec ? formatPrice(spec.price, spec.priceCurrency || currency) : "",
    imageUrl: absolute(picture(product.image) || meta(html, "og:image"))
  };
}

// Product pictures are on a plain (usually white) background. The colour in the corner is made
// transparent, so the product stands free on the card. A picture that already is transparent is left alone.
export async function cutout(buffer) {
  const img = await Jimp.read(buffer);
  const { width, height, data } = img.bitmap;
  const corner = (Math.min(2, height - 1) * width + Math.min(2, width - 1)) * 4;
  if (data[corner + 3] > 250) {
    const [cr, cg, cb] = [data[corner], data[corner + 1], data[corner + 2]];
    for (let i = 0; i < data.length; i += 4) {
      const dist = Math.sqrt((data[i] - cr) ** 2 + (data[i + 1] - cg) ** 2 + (data[i + 2] - cb) ** 2);
      if (dist < CUTOUT_THRESHOLD) data[i + 3] = 0;
      else if (dist < CUTOUT_THRESHOLD + CUTOUT_FEATHER) data[i + 3] = Math.round(data[i + 3] * ((dist - CUTOUT_THRESHOLD) / CUTOUT_FEATHER));
    }
  }
  if (width > CUTOUT_MAX_SIZE || height > CUTOUT_MAX_SIZE) img.scaleToFit({ w: CUTOUT_MAX_SIZE, h: CUTOUT_MAX_SIZE });
  return img.getBuffer("image/png");
}

// The product behind a link: its fields plus the picture as a PNG buffer (null when there is none or it failed).
export async function fetchProduct(address) {
  let page;
  try { page = await fetchPublic(address, { maxBytes: MAX_PAGE_BYTES, accept: "text/html,application/xhtml+xml" }); }
  catch (error) { throw new Error(error.name === "TimeoutError" ? "Siden svarede ikke i tide." : error.message || "Kunne ikke hente siden."); }
  const found = parseProductPage(page.buffer.toString("utf8"), page.url.href);

  let picture = null;
  if (found.imageUrl) {
    try {
      const file = await fetchPublic(found.imageUrl, { maxBytes: MAX_PICTURE_BYTES, accept: "image/png,image/jpeg,image/*;q=0.8" });
      picture = await cutout(file.buffer);
    } catch (error) {
      console.error("gear: could not fetch the product picture.", error.message);
    }
  }
  return { brand: found.brand, name: found.name, price: found.price, before: found.before, url: address, picture };
}
