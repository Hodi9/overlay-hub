import crypto from "node:crypto";

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

export function createSiteGate({ password, failDelayMs = 750 } = {}) {
  const secret = String(password ?? "");
  if (!secret) return (_req, _res, next) => next();
  const expected = sha256(secret);

  return async (req, res, next) => {
    const p = req.path.replace(/\/+$/, "").toLowerCase();
    if (p !== "" && p !== "/index.html") return next();

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
