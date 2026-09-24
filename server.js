import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import brovsbroModule from "./apps/brovsbro/app.cjs";
import { createMinecraftApp } from "./apps/minecraft/app.js";
import { createGearApp } from "./apps/gear/app.js";
import { createGearBfApp } from "./apps/gear-bf/app.js";
import { createGauntletApp } from "./apps/gauntlet/app.js";
import { createTlou2App } from "./apps/tlou2/app.js";
import { createGta5App } from "./apps/gta5/app.js";
import { createMafia1App } from "./apps/mafia1/app.js";
import { createMafia2App } from "./apps/mafia2/app.js";
import { createMafia3App } from "./apps/mafia3/app.js";
import { createPerfektMatchApp } from "./apps/perfektmatch/app.js";
import { createPokemonApp } from "./apps/pokemon/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { createBrovsbroApp } = brovsbroModule;

const app = express();
app.disable("x-powered-by");
const server = http.createServer(app);

app.get("/health", (_req, res) => res.json({ ok: true }));

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
    var link = u.toString();
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "Kopiér link til OBS";
    b.title = link;
    b.setAttribute("style", "position:fixed;right:16px;bottom:16px;z-index:2147483647;font:600 14px/1 system-ui,sans-serif;padding:12px 16px;border-radius:999px;border:2px solid #1b1733;background:#b9a6ff;color:#1b1733;cursor:pointer;box-shadow:0 8px 24px -8px rgba(0,0,0,.5)");
    b.addEventListener("click", function(){
      var done = function(){ b.textContent = "Kopieret ✓"; setTimeout(function(){ b.textContent = "Kopiér link til OBS"; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, fallback); else fallback();
      function fallback(){ var t = document.createElement("textarea"); t.value = link; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); } catch (e) {} t.remove(); done(); }
    });
    document.body.appendChild(b);
  });
})();</script>`;

const OVERLAY_PREFIXES = ["/brovsbro", "/minecraft", "/gear", "/gear-bf", "/gauntlet", "/tlou2", "/gta5", "/mafia1", "/mafia2", "/mafia3", "/perfektmatch", "/pokemon"];

app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  const p = req.path;
  const isOverlayApp = OVERLAY_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"));
  if (!isOverlayApp || /control|panel|api|\.(js|css|json|png|jpe?g|gif|svg|webp|ico|woff2?|mp3|mp4)$/i.test(p)) return next();

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
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, COPY_LINK_SNIPPET + "</body>") : html + COPY_LINK_SNIPPET;
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

app.use("/minecraft", createMinecraftApp());
app.use("/gear", createGearApp());
app.use("/gear-bf", createGearBfApp());
app.use("/gauntlet", createGauntletApp());
app.use("/tlou2", createTlou2App());
app.use("/gta5", createGta5App());
app.use("/mafia1", createMafia1App());
app.use("/mafia2", createMafia2App());
app.use("/mafia3", createMafia3App());
app.use("/perfektmatch", createPerfektMatchApp());
app.use("/pokemon", createPokemonApp());

app.use(express.static(path.join(__dirname, "public")));

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`overlay-hub listening on ${port}`);
});
