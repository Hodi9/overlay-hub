import crypto from "node:crypto";
import path from "node:path";
import express from "express";

// Valgfri adgangskode på selve forsiden (oversigten over overlays).
//
// Slås til ved at sætte SITE_PASSWORD på hosten. Uden den er forsiden åben som før.
// Kun forsiden ("/" og "/index.html") er bag koden: overlay-siderne bruges som browser
// sources i OBS, som ikke kan vise en login-side, og kontrolpanelerne har deres egne
// koder. /health og billeder er heller ikke låst.
//
// Besøgende får en lille login-side med kun ét felt (adgangskoden, ikke noget brugernavn).
// Rigtig kode giver en cookie, så de ikke skal skrive den igen i 30 dage. Cookien er en
// HMAC af koden, så den holder op med at virke, hvis SITE_PASSWORD skiftes. Et
// «Authorization: Basic»-header med koden virker stadig (brugernavnet ignoreres), fx til curl.

const COOKIE = "site_auth";
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest();

// Sammenligning i fast tid: begge sider hashes først, så de har samme længde.
const sameSecret = (given, expected) => crypto.timingSafeEqual(sha256(given), sha256(expected));

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

function loginPage(error) {
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Overlay</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0b0b0d">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px; background: #0b0b0d; color: #ededed; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { width: 100%; max-width: 340px; padding: 28px; background: #151518; border: 1px solid #2b2b31; border-radius: 18px; box-shadow: 0 10px 26px -14px rgba(0,0,0,.6); }
  h1 { margin: 0 0 18px; font-size: 20px; }
  input, button { width: 100%; padding: 12px 14px; border-radius: 12px; font: inherit; }
  input { background: #0b0b0d; color: inherit; border: 1px solid #2b2b31; }
  input:focus { outline: 2px solid #ffd60a; outline-offset: 1px; }
  button { margin-top: 12px; border: 0; background: #ffd60a; color: #0b0b0d; font-weight: 700; cursor: pointer; }
  .err { margin: 0 0 12px; color: #ff8a8a; font-size: 14px; }
</style>
</head>
<body>
<form method="post" action="/">
  <h1>Adgangskode</h1>
  ${error ? `<p class="err" role="alert">${error}</p>` : ""}
  <input type="password" name="password" autocomplete="current-password" aria-label="Adgangskode" autofocus required>
  <button type="submit">Åbn</button>
</form>
</body>
</html>`;
}

export function createSiteGate({ password, failDelayMs = 750 } = {}) {
  const secret = String(password ?? "");
  if (!secret) return (_req, _res, next) => next();
  const token = crypto.createHmac("sha256", sha256(secret)).update("overlay-site-gate:v1").digest("hex");
  const parseForm = express.urlencoded({ extended: false, limit: "2kb" });
  const readForm = (req, res) => new Promise((resolve) => parseForm(req, res, (err) => resolve(err ? {} : req.body || {})));
  const pause = () => new Promise((resolve) => setTimeout(resolve, failDelayMs));

  const hasCookie = (req) => (req.get("cookie") || "").split(";").some((part) => {
    const i = part.indexOf("=");
    return i > 0 && part.slice(0, i).trim() === COOKIE && sameSecret(part.slice(i + 1).trim(), token);
  });

  const hasBasic = (req) => {
    const match = /^Basic\s+(.+)$/i.exec(req.get("authorization") || "");
    if (!match) return false;
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    return sameSecret(decoded.slice(decoded.indexOf(":") + 1), secret);
  };

  const deny = (res, error) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.status(401).type("html").send(loginPage(error));
  };

  return async (req, res, next) => {
    if (!isFrontPage(req.path)) return next();

    if (req.method === "POST") {
      const given = (await readForm(req, res)).password;
      if (typeof given === "string" && sameSecret(given, secret)) {
        const secure = req.secure || req.get("x-forwarded-proto") === "https";
        res.set("Set-Cookie", `${COOKIE}=${token}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
        res.set("Cache-Control", "no-store");
        return res.redirect(303, "/");
      }
      await pause(); // bremser gætteri en smule
      return deny(res, "Forkert kode");
    }

    if (hasCookie(req) || hasBasic(req)) {
      res.set("Cache-Control", "private, no-cache"); // forsiden må ikke ligge i en delt cache
      return next();
    }
    if (req.get("authorization")) await pause();
    deny(res, "");
  };
}
