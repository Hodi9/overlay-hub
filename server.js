import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import brovsbroModule from "./apps/brovsbro/app.cjs";
import brosvsbrosModule from "./apps/brosvsbros/app.cjs";
import { createMinecraftApp } from "./apps/minecraft/app.js";
import { createGearApp } from "./apps/gear/app.js";
import { createGearBfApp } from "./apps/gear-bf/app.js";
import { createGauntletApp } from "./apps/gauntlet/app.js";
import { createTlou2App } from "./apps/tlou2/app.js";
import { createGta5App } from "./apps/gta5/app.js";
import { createCyberpunkApp } from "./apps/cyberpunk/app.js";
import { createMafia1App } from "./apps/mafia1/app.js";
import { createMafia2App } from "./apps/mafia2/app.js";
import { createMafia3App } from "./apps/mafia3/app.js";
import { createPerfektMatchApp } from "./apps/perfektmatch/app.js";
import { createPokemonApp } from "./apps/pokemon/app.js";
import { createRdr2DeathsApp } from "./apps/rdr2-deaths/app.js";
import { createRdr2App } from "./apps/rdr2/app.js";
import { createWalkApp } from "./apps/walk/app.js";
import { injectHomeCard } from "./apps/walk/homeCard.js";
import { collapseLeadingSlashes } from "./collapseLeadingSlashes.js";
import { createChannelRegistry, createChannelsRouter, createTenantDispatcher } from "./apps/_lib/channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { createBrovsbroApp } = brovsbroModule;
const { createBrosvsbrosApp } = brosvsbrosModule;

const app = express();
app.disable("x-powered-by");
// Render puts one proxy in front of the app; without this every visitor would share
// the proxy's IP in the rate limits for creating channels and failed key attempts.
app.set("trust proxy", 1);
const server = http.createServer(app);

// Skal ligge allerførst, så alt efter ser den rene sti.
app.use(collapseLeadingSlashes);

app.get("/health", (_req, res) => res.json({ ok: true }));

// One connection pool for the whole hub, and the channels everything below checks keys against.
const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    })
  : null;
// An idle connection that errors would otherwise be an unhandled 'error' event and stop the server.
pool?.on("error", (error) => console.error("database pool error", error));
const channels = createChannelRegistry({ pool });

// A request must not be answered before the channels are loaded, or a channel's
// link would briefly be treated as an unknown one.
app.use((_req, _res, next) => { channels.ready.then(() => next(), next); });

app.use("/api/channels", createChannelsRouter({ registry: channels }));

// "Kopiér link"-knap på alle overlay-sider. Knappen vises kun i en almindelig
// browser — aldrig i OBS (window.obsstudio / OBS user agent) eller i en iframe
// (fx Pogly) — så den kommer ikke med på streamen.
const COPY_LINK_SNIPPET = `<script>(function(){
  var ua = navigator.userAgent || "";
  if (window.obsstudio || /OBS\\//.test(ua) || window.self !== window.top) return;
  function ready(fn){ document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn(); }
  ready(function(){
    var cs = function(el){ return getComputedStyle(el).backgroundColor; };
    var clear = function(c){ return c === "rgba(0, 0, 0, 0)" || c === "transparent"; };
    if (clear(cs(document.documentElement)) && clear(cs(document.body))) document.documentElement.style.background = "#111";
    var u = new URL(location.href); u.searchParams.delete("bg");
    if (u.searchParams.has("preview")) ["preview","etape","day","from","to","km","min","paused","arrived"].forEach(function(k){ u.searchParams.delete(k); }); // testværdier hører ikke hjemme i OBS-linket
    var link = u.toString();
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "Kopiér link til OBS";
    b.title = link;
    b.setAttribute("style", "position:fixed;right:16px;bottom:16px;z-index:2147483647;font:600 14px/1 system-ui,sans-serif;padding:12px 16px;border-radius:999px;border:2px solid #17131f;background:#c7b6ff;color:#17131f;cursor:pointer;box-shadow:0 8px 24px -8px rgba(0,0,0,.5)");
    b.addEventListener("click", function(){
      var done = function(){ b.textContent = "Kopieret ✓"; setTimeout(function(){ b.textContent = "Kopiér link til OBS"; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, fallback); else fallback();
      function fallback(){ var t = document.createElement("textarea"); t.value = link; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); } catch (e) {} t.remove(); done(); }
    });
    document.body.appendChild(b);
  });
})();</script>`;

// Adds ?profile=<channel> to a channel page's own requests and sends its key along (public/_hub/channel.js).
const CHANNEL_SHIM_TAG = '<script src="/_hub/channel.js"></script>';

const OVERLAY_PREFIXES = ["/brovsbro", "/brosvsbros", "/minecraft", "/gear", "/gear-bf", "/gauntlet", "/tlou2", "/gta5", "/cyberpunk", "/mafia1", "/mafia2", "/mafia3", "/perfektmatch", "/pokemon", "/rdr2-deaths", "/rdr2"];

app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  const p = req.path;
  const isOverlayApp = OVERLAY_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"));
  const isAsset = /\.(js|css|json|png|jpe?g|gif|svg|webp|ico|woff2?|mp3|mp4)$/i.test(p);
  const isApi = /api/i.test(p);
  // The copy-link button stays off control panels; the channel shim goes on every page of a channel.
  const wantCopyLink = isOverlayApp && !isAsset && !isApi && !/control|panel/i.test(p);
  const wantShim = isOverlayApp && !isAsset && !isApi && typeof req.query.profile === "string" && req.query.profile !== "";
  if (!wantCopyLink && !wantShim) return next();

  const write = res.write.bind(res);
  const end = res.end.bind(res);
  let chunks = null;
  const isHtml = () => /text\/html/i.test(String(res.getHeader("content-type") || ""));

  res.write = (chunk, ...args) => {
    if (chunks === null && !isHtml()) { chunks = false; }
    if (chunks === false) return write(chunk, ...args);
    chunks = chunks || [];
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof args[0] === "string" ? args[0] : "utf8"));
    return true;
  };
  res.end = (chunk, ...args) => {
    if (chunks === null && !isHtml()) chunks = false;
    if (chunks === false || req.method === "HEAD" || res.statusCode !== 200) {
      if (chunks) chunks.forEach((c) => write(c));
      return end(chunk, ...args);
    }
    chunks = chunks || [];
    if (chunk && typeof chunk !== "function") chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof args[0] === "string" ? args[0] : "utf8"));
    let html = Buffer.concat(chunks).toString("utf8");
    if (wantShim) html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (open) => open + CHANNEL_SHIM_TAG) : CHANNEL_SHIM_TAG + html;
    if (wantCopyLink) html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, COPY_LINK_SNIPPET + "</body>") : html + COPY_LINK_SNIPPET;
    const body = Buffer.from(html, "utf8");
    if (!res.headersSent) {
      res.removeHeader("ETag");
      res.setHeader("Content-Length", body.length);
    }
    return end(body);
  };
  next();
});

const { router: brovsbroRouter, attachSocket } = createBrovsbroApp();
app.use("/brovsbro", brovsbroRouter);
attachSocket(server);

const { router: brosvsbrosRouter, attachSocket: attachBrosvsbrosSocket } = createBrosvsbrosApp({ channels, pool });
app.use("/brosvsbros", brosvsbrosRouter);
attachBrosvsbrosSocket(server);

// Apps that keep one state in a closure get a copy per channel (?profile=<id>); the apps
// that already had profiles check the channel's keys themselves.
app.use("/minecraft", createTenantDispatcher({
  registry: channels, pool,
  legacy: createMinecraftApp({ pool }),
  factory: (context) => createMinecraftApp(context)
}));
app.use("/gear", createGearApp());
app.use("/gear-bf", createGearBfApp());
app.use("/gauntlet", createTenantDispatcher({
  registry: channels, pool,
  legacy: createGauntletApp({ pool }),
  factory: (context) => createGauntletApp(context)
}));
app.use("/tlou2", createTlou2App({ channels, pool }));
app.use("/gta5", createGta5App({ channels, pool }));
app.use("/cyberpunk", createCyberpunkApp({ channels, pool }));
app.use("/mafia1", createMafia1App({ channels, pool }));
app.use("/mafia2", createMafia2App({ channels, pool }));
app.use("/mafia3", createMafia3App({ channels, pool }));
app.use("/perfektmatch", createPerfektMatchApp());
// Channels copy their chase list from the main instance instead of scraping the price sources again.
const pokemonMain = createPokemonApp({ context: { pool } });
app.use("/pokemon", createTenantDispatcher({
  registry: channels, pool,
  legacy: pokemonMain,
  factory: (context) => createPokemonApp({ context, sharedChase: () => pokemonMain.chaseCards() })
}));
app.use("/rdr2-deaths", createRdr2DeathsApp({ channels, pool }));
app.use("/rdr2", createRdr2App({ channels, pool }));

// Hidden walk-through-Denmark overlay (apps/walk). Same idea: not on the index page,
// only mounted at the secret address in WALK_PATH, 404 everywhere else.
const walkPath = "/" + String(process.env.WALK_PATH || "").trim().replace(/^\/+|\/+$/g, "");
if (/^\/[A-Za-z0-9_-]{12,}$/.test(walkPath)) {
  OVERLAY_PREFIXES.push(walkPath);
  app.use(walkPath, createWalkApp());
  // Marcel Walk-kortet på forsiden er skjult, til WALK_SHOW_ON_HOME=1 (se apps/walk/homeCard.js).
  if (process.env.WALK_SHOW_ON_HOME === "1") {
    app.get(["/", "/index.html"], async (_req, res, next) => {
      try {
        const html = await fs.readFile(path.join(__dirname, "public", "index.html"), "utf8");
        res.type("html").send(injectHomeCard(html, walkPath));
      } catch (error) { next(error); }
    });
  }
} else if (process.env.WALK_PATH) console.warn("walk: WALK_PATH must be 12+ letters/digits/-/_ — overlay not mounted.");

app.use(express.static(path.join(__dirname, "public")));

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`dreamglow listening on ${port}`);
});
