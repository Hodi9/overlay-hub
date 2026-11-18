// GTA VI stream reader: watches streamers' public Twitch streams, reads the mission title card GTA shows in the
// bottom-right corner, and sets that mission as "playing now" on each streamer's own tracker (the mission played
// before it is ticked off by the server). Runs on any Windows PC with ffmpeg; OCR is Windows' own (ocr-worker.ps1).
//
//   node reader.mjs              uses config.json next to this file (copy config.example.json)
//   node reader.mjs --dry-run    reads and logs, sends nothing
//
// Safety, so a stream can never move another streamer's tracker or loop on its own overlay:
// - each stream is read from its own Twitch playlist and sent only to the tracker paired with it in config.json,
//   with that tracker's own key; the server also refuses text whose stream is not the channel's own (409)
// - only the bottom-right crop is read (config "region"), not the area where the overlays sit
// - only a whole mission name counts (no partial words); the mission already playing and missions already ticked
//   off are ignored, so the overlay's own "GONE FISHING" line can never change anything
// - a title must be read twice in a row, and after a change that stream waits 60 s before the next one
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // Twitch's public web-player client id (as streamlink uses)
const CONFIRM_MS = 12000; // the second reading of the same title must come within this
const COOLDOWN_MS = 60000; // after a change, no further change on that stream for this long
const MIN_SIMILARITY = 0.85;
const MAX_SAVED_CROPS = 300;

// Set from config.json when run (not when tests import the matching functions).
let config = {};
let dryRun = true;
let panelUrl = "https://dreamglow.xyz";
let intervalSeconds = 2;
const workDir = path.join(HERE, "captures");
const logFile = path.join(HERE, "reader.log");

function log(stream, message) {
  const line = `${new Date().toLocaleTimeString("da-DK")} ${stream ? `[${stream}] ` : ""}${message}`;
  console.log(line);
  fs.appendFile(logFile, line + "\n", () => {});
}

// ---- text matching ----------------------------------------------------------------------------------------
export function normalize(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

// The mission a set of OCR lines names, or null. Each line, and each pair of neighbouring lines (a title that
// wraps), must match a whole mission name closely; a word that is merely part of a name never counts.
export function findMission(lines, chapters, skipIds) {
  const candidates = [];
  // Subtitles reach into the corner: a line cut off mid-sentence starts with a small letter, and spoken lines end
  // with "." or ",". Mission names do neither, so those lines are never matched.
  const clean = lines.map((l) => String(l).trim())
    .filter((l) => l && !/^[a-z]/.test(l) && !/[.,]$/.test(l))
    .map(normalize).filter(Boolean);
  for (let i = 0; i < clean.length; i++) {
    candidates.push(clean[i]);
    if (i + 1 < clean.length) candidates.push(`${clean[i]} ${clean[i + 1]}`);
  }
  let best = null;
  for (const chapter of chapters) {
    if (skipIds.has(chapter.id)) continue;
    const target = normalize(chapter.day);
    if (target.length < 4 || /spoiler/.test(target)) continue;
    for (const text of candidates) {
      const score = similarity(text, target);
      if (score >= MIN_SIMILARITY && (!best || score > best.score)) best = { chapter, score, text };
    }
  }
  return best;
}

// ---- OCR worker -------------------------------------------------------------------------------------------
function startOcr() {
  const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "ocr-worker.ps1")], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = [];
  let buffer = "";
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { readyResolve(); continue; }
      if (msg.error && !waiting.length) { log("", `OCR: ${msg.error}`); continue; }
      const next = waiting.shift();
      if (next) next(Array.isArray(msg.lines) ? msg.lines : msg.lines ? [msg.lines] : []);
    }
  });
  child.on("exit", (code) => { log("", `OCR-hjælperen stoppede (kode ${code}).`); process.exit(1); });
  // One image at a time; a second request waits its turn.
  let chain = Promise.resolve();
  const read = (file) => (chain = chain.then(() => new Promise((resolve) => {
    waiting.push(resolve);
    child.stdin.write(file + "\n");
  })));
  return { ready, read };
}

// ---- Twitch playlist --------------------------------------------------------------------------------------
async function playlistUrl(login) {
  const query = `query { streamPlaybackAccessToken(channelName: "${login}", params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }`;
  const r = await fetch("https://gql.twitch.tv/gql", { method: "POST", headers: { "Client-ID": CLIENT_ID, "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  const token = (await r.json())?.data?.streamPlaybackAccessToken;
  if (!token) throw new Error("ingen adgangstoken (findes kanalen?)");
  const url = `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?sig=${token.signature}&token=${encodeURIComponent(token.value)}&allow_source=true&p=${Math.floor(Math.random() * 1e7)}`;
  const res = await fetch(url);
  if (res.status === 404) return null; // offline
  if (!res.ok) throw new Error(`playlist svarede ${res.status}`);
  const lines = (await res.text()).split("\n");
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXT-X-STREAM-INF:.*RESOLUTION=(\d+)x(\d+)/);
    if (m) variants.push({ height: Number(m[2]), url: lines[i + 1].trim() });
  }
  variants.sort((a, b) => Math.abs(a.height - 720) - Math.abs(b.height - 720));
  return variants[0]?.url || null;
}

// ---- tracker API ------------------------------------------------------------------------------------------
function trackerUrl(stream, route) {
  return `${panelUrl}/gta6/api/${route}${stream.profile ? `?profile=${encodeURIComponent(stream.profile)}` : ""}`;
}

async function loadState(stream) {
  const res = await fetch(trackerUrl(stream, "state"));
  if (!res.ok) throw new Error(`tracker svarede ${res.status}`);
  return res.json();
}

async function sendMission(stream, mission) {
  const res = await fetch(trackerUrl(stream, "tracker"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${stream.apiKey}` },
    body: JSON.stringify({ text: mission.day, source: stream.twitch, profile: stream.profile || undefined })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `tracker svarede ${res.status}`);
  return body;
}

// ---- one stream -------------------------------------------------------------------------------------------
function pruneCrops(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_SAVED_CROPS))) fs.rmSync(path.join(dir, f), { force: true });
}

function runStream(stream, ocr) {
  const name = stream.twitch;
  const region = { x: 0.6, y: 0.83, w: 0.4, h: 0.16, ...(stream.region || {}) };
  const cropDir = path.join(workDir, name);
  fs.mkdirSync(cropDir, { recursive: true });
  let state = null;
  let pending = null; // { id, at } — first reading of a title, waiting for the second
  let lastChangeAt = 0;
  let busy = false;

  async function refreshState() {
    try { state = await loadState(stream); } catch (error) { log(name, `Kunne ikke hente trackeren: ${error.message}`); }
  }
  refreshState();
  setInterval(refreshState, 60000).unref();

  async function handleFrame(png) {
    if (busy || !state) return;
    busy = true;
    try {
      const file = path.join(workDir, `${name}-latest.png`);
      fs.writeFileSync(file, png);
      const lines = (await ocr.read(file)).map((l) => String(l).trim()).filter(Boolean);
      if (!lines.length) return;
      // Keep what was read (for checking the crop and the reading later).
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(file, path.join(cropDir, `${stamp}.png`));
      pruneCrops(cropDir);

      const skip = new Set(state.done || []);
      if (state.current) skip.add(state.current.id);
      const hit = findMission(lines, state.chapters || [], skip);
      log(name, `læste: ${JSON.stringify(lines.join(" | "))}${hit ? ` → ligner "${hit.chapter.day}" (${Math.round(hit.score * 100)}%)` : ""}`);
      if (!hit) return;

      const now = Date.now();
      if (now - lastChangeAt < COOLDOWN_MS) return;
      if (!pending || pending.id !== hit.chapter.id || now - pending.at > CONFIRM_MS) {
        pending = { id: hit.chapter.id, at: now };
        return;
      }
      pending = null;
      lastChangeAt = now;
      if (dryRun) {
        log(name, `PRØVE: ville sætte "${hit.chapter.day}" som spiller nu på ${stream.profile ? `kanal ${stream.profile}` : "hovedtrackeren"} (sender intet).`);
        return;
      }
      const result = await sendMission(stream, hit.chapter);
      log(name, result.matched ? `Sat: "${hit.chapter.day}" spiller nu.` : `Serveren matchede ikke "${hit.chapter.day}".`);
      await refreshState();
    } catch (error) {
      log(name, `Fejl: ${error.message}`);
    } finally {
      busy = false;
    }
  }

  async function connect() {
    let url;
    try {
      url = await playlistUrl(name);
    } catch (error) {
      log(name, `Kunne ikke hente streamen: ${error.message}. Prøver igen om 60 s.`);
      return setTimeout(connect, 60000);
    }
    if (!url) {
      log(name, "Offline. Tjekker igen om 60 s.");
      return setTimeout(connect, 60000);
    }
    log(name, "Live — læser nederste højre hjørne.");
    const crop = `crop=iw*${region.w}:ih*${region.h}:iw*${region.x}:ih*${region.y}`;
    const ff = spawn("ffmpeg", ["-loglevel", "error", "-i", url, "-vf", `fps=1/${intervalSeconds},${crop},scale=iw*2:-1`, "-f", "image2pipe", "-c:v", "png", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = Buffer.alloc(0);
    const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    ff.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let end;
      while ((end = buf.indexOf(IEND)) >= 0) {
        const png = buf.subarray(0, end + IEND.length);
        buf = buf.subarray(end + IEND.length);
        handleFrame(Buffer.from(png));
      }
    });
    ff.stderr.on("data", (d) => { const t = String(d).trim(); if (t) log(name, `ffmpeg: ${t.slice(0, 200)}`); });
    ff.on("exit", () => {
      log(name, "Streamen stoppede (offline eller ny adgang). Forbinder igen om 15 s.");
      setTimeout(connect, 15000);
    });
  }
  connect();
}

// ---- start ------------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith("--")) || path.join(HERE, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(`Mangler ${configPath}. Kopiér config.example.json til config.json og udfyld den.`);
    process.exit(1);
  }
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  dryRun = args.includes("--dry-run") || config.dryRun === true;
  panelUrl = String(config.panelUrl || "https://dreamglow.xyz").replace(/\/+$/, "");
  intervalSeconds = Math.max(1, Number(config.intervalSeconds) || 2);
  fs.mkdirSync(workDir, { recursive: true });
  const streams = (config.streams || []).filter((s) => s && s.twitch);
  if (!streams.length) { console.error("Ingen streams i config.json."); process.exit(1); }
  for (const s of streams) {
    if (!dryRun && !s.apiKey) { console.error(`[${s.twitch}] mangler apiKey (trackerens nøgle) i config.json.`); process.exit(1); }
  }
  log("", `Starter${dryRun ? " i PRØVETILSTAND (sender intet)" : ""}: ${streams.map((s) => `${s.twitch} → ${s.profile ? `kanal ${s.profile}` : "hovedtrackeren"}`).join(", ")}`);
  const ocr = startOcr();
  await ocr.ready;
  for (const s of streams) runStream(s, ocr);
}
