import crypto from "node:crypto";
import path from "node:path";

// Valgfri adgangskode på selve forsiden (oversigten over overlays).
//
// Slås til ved at sætte SITE_PASSWORD på hosten. Uden den er forsiden åben som før.
// Kun forsiden ("/" og "/index.html") er bag koden: overlay-siderne bruges som browser
// sources i OBS, som ikke kan vise en login-dialog, og kontrolpanelerne har deres egne
// koder. /health og billeder er heller ikke låst.
//
// Browseren viser sin egen login-dialog (HTTP Basic). Brugernavnet ignoreres — kun
// adgangskoden tæller.

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest();

// Ender denne sti på forsiden? Stien dekodes og ryddes op på samme måde som filserveren gør,
// så kodede tegn (/%69ndex.html), "//", "./" og "../" ikke kan snige sig uden om koden.
// Ugyldig kodning regnes som forsiden, så den afvises i stedet for at slippe igennem.
function isFrontPage(rawPath) {
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return true; }
  const clean = path.posix.normalize("/" + decoded.replace(/\\/g, "/")).replace(/\/+$/, "").toLowerCase();
  return clean === "" || clean === "/index.html";
}

// Et link med dobbelt skråstreg forrest ("https://site.com//sti") virker som med ét.
export function collapseLeadingSlashes(req, _res, next) {
  if (req.url.startsWith("//")) req.url = req.url.replace(/^\/{2,}/, "/");
  next();
}

export function createSiteGate({ password, failDelayMs = 750 } = {}) {
  const secret = String(password ?? "");
  if (!secret) return (_req, _res, next) => next();
  const expected = sha256(secret);

  return async (req, res, next) => {
    if (!isFrontPage(req.path)) return next();

    const match = /^Basic\s+(.+)$/i.exec(req.get("authorization") || "");
    if (match) {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const given = decoded.slice(decoded.indexOf(":") + 1);
      // Sammenlign hashes med fast tid, så svartiden ikke afslører noget om koden.
      if (crypto.timingSafeEqual(sha256(given), expected)) return next();
      // Bremser gætteri en smule.
      await new Promise((resolve) => setTimeout(resolve, failDelayMs));
    }

    res.set("WWW-Authenticate", 'Basic realm="Overlay", charset="UTF-8"');
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.status(401).type("text/plain").send("Adgangskode påkrævet");
  };
}
