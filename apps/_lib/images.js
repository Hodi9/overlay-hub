import crypto from "node:crypto";

// Small pictures that a control panel uploads (a product, a team logo). They are kept apart from the
// state the overlay listens to, so a score change does not send every picture again: the state only
// carries a short version string, and the picture itself is fetched from the app's own image address.

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGE_BYTES = 400 * 1024;

const version = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 10);

// { type, buffer, version } from a data URL, or null when it is not a picture we accept or it is too big.
export function imageFromDataUrl(dataUrl, maxBytes = MAX_IMAGE_BYTES) {
  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(typeof dataUrl === "string" ? dataUrl : "");
  if (!match || !TYPES.includes(match[1])) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > maxBytes) return null;
  return { type: match[1], buffer, version: version(buffer) };
}

export function imageFromBuffer(buffer, type, maxBytes = MAX_IMAGE_BYTES) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maxBytes || !TYPES.includes(type)) return null;
  return { type, buffer, version: version(buffer) };
}

// What goes in the database and back again.
export const packImages = (images) => Object.fromEntries([...images].map(([id, image]) => [id, { type: image.type, data: image.buffer.toString("base64") }]));

export function unpackImages(saved, maxBytes = MAX_IMAGE_BYTES) {
  const images = new Map();
  for (const [id, raw] of Object.entries(saved && typeof saved === "object" ? saved : {})) {
    if (typeof raw?.data !== "string") continue;
    const image = imageFromBuffer(Buffer.from(raw.data, "base64"), raw.type, maxBytes);
    if (image) images.set(id, image);
  }
  return images;
}

// Answers a request for one picture. The address carries the version, so the browser may keep it for good.
export function sendImage(images, id, response) {
  const image = images.get(id);
  if (!image) return response.status(404).end();
  response.set({ "Content-Type": image.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  response.end(image.buffer);
}
