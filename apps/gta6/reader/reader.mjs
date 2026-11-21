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
// - a near-exact title counts at once, a less certain one must be read twice; after a change that stream waits 60 s
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // Twitch's public web-player client id (as streamlink uses)
const CONFIRM_MS = 12000; // the second reading of the same title must come within this
const COOLDOWN_MS = 60000; // after a change, no further change on that stream for this long
const MIN_SIMILARITY = 0.85;
const SURE_SIMILARITY = 0.95; // this close to a whole mission name, one reading is enough
const MAX_SAVED_CROPS = 300;
const MENU_SIMILARITY = 0.9; // a mission name in the pause menu must be this close
const MENU_CONFIRM_MS = 30000; // and be read twice within this (the menu stays open for a while)
const MENU_SECONDS = 3; // how often the pause-menu corner is read
const HINT_CONFIRM_MS = 5 * 60 * 1000;
const HINT_REPEAT_MS = 20 * 60 * 1000;
const UNKNOWN_REPEAT_MS = 10 * 60 * 1000;
const MAX_UNKNOWN = 300;

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

// ---- pause menu -------------------------------------------------------------------------------------------
// The pause menu shows, top right, "CHAPTER 4" on a line of its own, the mission being played under it and
// "Last Checkpoint". Only a read that has that bare chapter line counts (the streamers' own overlays say
// "CHAPTER 4: VICE CITY, BABY", with a colon, so they never do), and only missions of that chapter are looked at.
export function menuChapter(lines) {
  for (const line of lines) {
    const m = String(line).trim().match(/^chapter\s*([1-5])$/i);
    if (m) return Number(m[1]);
  }
  return null;
}

export function findMenuMission(lines, chapters, skipIds) {
  const chapter = menuChapter(lines);
  if (!chapter) return null;
  const inChapter = chapters.filter((c) => String(c.location || "").toLowerCase().startsWith(`chapter ${chapter}:`));
  const hit = findMission(lines.filter((l) => !/^chapter\s*[1-5]$/i.test(String(l).trim())), inChapter, skipIds);
  return hit && hit.score >= MENU_SIMILARITY ? { ...hit, chapterNumber: chapter } : null;
}

// ---- unknown titles ---------------------------------------------------------------------------------------
// Text that looks like a mission title card (a few words in capitals) but matches no mission. A picture of it is
// kept, so a title the reader missed, or a name the game spells differently from the list, can be found later.
const UI_WORDS = /\b(DESTINATION|SELECT|DEFUSE|PROVOKE|THREATEN|WAYPOINT|RESET|EXIT|BACK|HOLD|HANDS|TAKE OFF|PUT ON|PUTON|SURRENDER|STAFF|MEMBER|STRANGER|SCROLL|CLOSE|MENU|INSPECT|SKIP|ROB|DRIVER|RETURN|SEAT|ZOOM|REMOVE|MARKER|LOADING|SALESMAN|CLERK|DRINK|DANCE|DIVE|SURFACE|REFUEL|BOOST|SMOKE|DROP|THROW|APPLY|ROLL|USE|SHOTGUN|PISTOL|RIFLE|SMG|REVOLVER|ACCELERATE|ROTATE|TOGGLE|CHOOSE|FEED|PLAY WITH|CALL|BUY|WEAR|LIFT|MOVE|SET|ENABLE|DISABLE|VIEW|NAMES|PRESS|FOCUS|STASH|TELLER|MANAGER|LEAVE|BOUNCER|RECEPTIONIST|BARTENDER|SECURITY GUARD|CAUTION|PHOTO STUDIO|DETONATE|REGROUP|GUARDS|STUDY|CUE|BALL|OPPONENT|RATING|RADIO|SCREW|PULL|PICK UP|INVENTORY|MAP|PAUSE)\b/;
export function looksLikeTitle(line) {
  const text = String(line || "").trim();
  if (text.length < 5 || text.length > 40) return false;
  if (!/^[A-Z][A-Z'’!?&,\- ]*[A-Z!?]$/.test(text)) return false; // capitals only, like the title cards
  if (/[0-9@]/.test(text) || UI_WORDS.test(text)) return false;
  return text.split(/\s+/).length >= 2 || text.length >= 7;
}

// ---- hints from words on screen ---------------------------------------------------------------------------
// hints.json: { "Party Hard": ["Megamundo", ...], ... } — names and places that belong to one mission only.
// A hint is only a suggestion in the panel ("Måske: Party Hard"), confirmed by hand; it never moves the tracker.
// To keep it from jumping around, a word must be read in two separate frames within HINT_CONFIRM_MS, the mission
// must not be playing or ticked off, it must be in the chapter of the mission playing now, and the same mission
// is not suggested again within HINT_REPEAT_MS.
export function compileHints(table) {
  return Object.entries(table || {}).flatMap(([mission, words]) => (Array.isArray(words) ? words : [])
    .map((word) => String(word).trim()).filter((word) => word.length >= 4)
    .map((word) => ({ mission, word, re: new RegExp(`(^|[^a-z0-9])${normalize(word).replace(/ /g, "\\s+")}([^a-z0-9]|$)`) })));
}

export function findHint(lines, hints, chapters, skipIds, currentChapterName) {
  const text = normalize(lines.join(" "));
  if (!text || !currentChapterName) return null;
  for (const hint of hints) {
    if (!hint.re.test(text)) continue;
    const chapter = chapters.find((c) => normalize(c.day) === normalize(hint.mission));
    if (!chapter || skipIds.has(chapter.id)) continue;
    if (String(chapter.location || "") !== currentChapterName) continue;
    return { chapter, word: hint.word };
  }
  return null;
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
  if (res.status === 423) return { matched: false, disabled: true };
  if (!res.ok) throw new Error(body.error || `tracker svarede ${res.status}`);
  return body;
}

async function sendHint(stream, mission, word) {
  const res = await fetch(trackerUrl(stream, "hint"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${stream.apiKey}` },
    body: JSON.stringify({ id: mission.id, keyword: word, source: stream.twitch, profile: stream.profile || undefined })
  });
  if (res.status === 423) return "slået fra";
  if (res.status === 404) return "serveren kender ikke forslag endnu";
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `tracker svarede ${res.status}`);
  return "vist i panelet";
}

function loadHints() {
  try {
    return compileHints(JSON.parse(fs.readFileSync(path.join(HERE, "hints.json"), "utf8")));
  } catch (error) {
    log("", `hints.json kunne ikke læses (${error.message}); ingen forslag.`);
    return [];
  }
}

// ---- one stream -------------------------------------------------------------------------------------------
function pruneCrops(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_SAVED_CROPS))) fs.rmSync(path.join(dir, f), { force: true });
}

function runStream(stream, ocr, hints) {
  const name = stream.twitch;
  const region = { x: 0.6, y: 0.83, w: 0.4, h: 0.16, ...(stream.region || {}) };
  const menuRegion = { x: 0.5, y: 0.08, w: 0.5, h: 0.24, ...(stream.menuRegion || {}) };
  const cropDir = path.join(workDir, name);
  const unknownDir = path.join(workDir, "ukendte", name);
  fs.mkdirSync(cropDir, { recursive: true });
  fs.mkdirSync(unknownDir, { recursive: true });
  let state = null;
  let pending = null; // { id, at } — first reading of a title, waiting for the second
  let menuPending = null; // the same for the pause menu
  let lastChangeAt = 0;
  let busy = false;
  let menuBusy = false;
  const hintSeen = new Map(); // mission id -> first time its word was read (waiting for a second frame)
  const hintSent = new Map(); // mission id -> when it was last suggested
  const unknownSaved = new Map(); // text -> when its picture was last kept

  const skipIds = () => {
    const skip = new Set(state.done || []);
    if (state.current) skip.add(state.current.id);
    return skip;
  };

  // Text that looks like a title but matched nothing: keep a picture of it (at most once per 10 min per text).
  function keepUnknown(file, lines, where) {
    const now = Date.now();
    for (const line of lines) {
      if (!looksLikeTitle(line)) continue;
      const key = normalize(line);
      if (now - (unknownSaved.get(key) || 0) < UNKNOWN_REPEAT_MS) continue;
      // Mission names already on the list (playing or ticked off) are known, not unknown.
      if ((state.chapters || []).some((c) => similarity(key, normalize(c.day)) >= MIN_SIMILARITY)) continue;
      unknownSaved.set(key, now);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safe = key.replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      try {
        fs.copyFileSync(file, path.join(unknownDir, `${stamp}-${where}-${safe}.png`));
        const files = fs.readdirSync(unknownDir).filter((f) => f.endsWith(".png")).sort();
        for (const f of files.slice(0, Math.max(0, files.length - MAX_UNKNOWN))) fs.rmSync(path.join(unknownDir, f), { force: true });
      } catch { /* a picture is a nice-to-have */ }
      log(name, `Ukendt titel? "${line}" (${where}) — billede gemt i captures/ukendte/${name}.`);
    }
  }

  async function maybeHint(lines) {
    if (!hints.length || dryRun || state.readerEnabled === false || !state.current) return;
    const hit = findHint(lines, hints, state.chapters || [], skipIds(), state.current.location);
    if (!hit) return;
    const now = Date.now();
    const id = hit.chapter.id;
    if (now - (hintSent.get(id) || 0) < HINT_REPEAT_MS) return;
    const first = hintSeen.get(id);
    if (!first || now - first > HINT_CONFIRM_MS) { hintSeen.set(id, now); return; } // wait for a second frame
    // The second frame must be a separate moment, not the same subtitle read twice in a row.
    if (now - first < 5000) return;
    hintSeen.delete(id);
    hintSent.set(id, now);
    const result = await sendHint(stream, hit.chapter, hit.word);
    log(name, `Forslag: "${hit.chapter.day}" (så "${hit.word}") — ${result}.`);
  }

  async function handleMenuFrame(png) {
    if (menuBusy || !state) return;
    menuBusy = true;
    try {
      const file = path.join(workDir, `${name}-menu-latest.png`);
      fs.writeFileSync(file, png);
      const lines = (await ocr.read(file)).map((l) => String(l).trim()).filter(Boolean);
      const chapter = menuChapter(lines);
      if (!chapter) return; // not the pause menu
      const hit = findMenuMission(lines, state.chapters || [], skipIds());
      log(name, `pausemenu: ${JSON.stringify(lines.join(" | "))}${hit ? ` → ligner "${hit.chapter.day}" (${Math.round(hit.score * 100)}%)` : ""}`);
      if (!hit) {
        // The menu names a mission that is not open on the list (or that the list spells differently).
        const playing = state.current && lines.some((l) => similarity(normalize(l), normalize(state.current.day)) >= MIN_SIMILARITY);
        if (!playing) keepUnknown(file, lines, "pausemenu");
        return;
      }
      const now = Date.now();
      if (now - lastChangeAt < COOLDOWN_MS) return;
      if (!menuPending || menuPending.id !== hit.chapter.id || now - menuPending.at > MENU_CONFIRM_MS) {
        menuPending = { id: hit.chapter.id, at: now };
        return;
      }
      menuPending = null;
      await setPlaying(hit.chapter, "pausemenuen");
    } catch (error) {
      log(name, `Fejl (pausemenu): ${error.message}`);
    } finally {
      menuBusy = false;
    }
  }

  async function setPlaying(chapter, from) {
    lastChangeAt = Date.now();
    if (state.readerEnabled === false) {
      log(name, `Så "${chapter.day}" i ${from}, men automatisk læsning er slået fra i panelet — sender intet.`);
      return;
    }
    if (dryRun) {
      log(name, `PRØVE: ville sætte "${chapter.day}" (fra ${from}) som spiller nu (sender intet).`);
      return;
    }
    const result = await sendMission(stream, chapter);
    log(name, result.disabled ? `Afvist: automatisk læsning er slået fra i panelet.` : result.matched ? `Sat: "${chapter.day}" spiller nu (fra ${from}).` : `Serveren matchede ikke "${chapter.day}".`);
    await refreshState();
  }

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

      const hit = findMission(lines, state.chapters || [], skipIds());
      log(name, `læste: ${JSON.stringify(lines.join(" | "))}${hit ? ` → ligner "${hit.chapter.day}" (${Math.round(hit.score * 100)}%)` : ""}`);
      if (!hit) {
        keepUnknown(file, lines, "titel");
        await maybeHint(lines);
        return;
      }

      const now = Date.now();
      if (now - lastChangeAt < COOLDOWN_MS) return;
      // A near-exact reading of a whole mission name counts at once (title cards can be on screen for only
      // ~2 s); a less certain one must be read twice.
      const sure = hit.score >= SURE_SIMILARITY;
      if (!sure && (!pending || pending.id !== hit.chapter.id || now - pending.at > CONFIRM_MS)) {
        pending = { id: hit.chapter.id, at: now };
        return;
      }
      pending = null;
      await setPlaying(hit.chapter, "titelkortet");
    } catch (error) {
      log(name, `Fejl: ${error.message}`);
    } finally {
      busy = false;
    }
  }

  // One ffmpeg per corner: the title-card corner every intervalSeconds, the pause-menu corner every MENU_SECONDS.
  function capture(kind) {
    const isMenu = kind === "menu";
    const area = isMenu ? menuRegion : region;
    const seconds = isMenu ? MENU_SECONDS : intervalSeconds;
    const onPng = isMenu ? handleMenuFrame : handleFrame;
    const quiet = isMenu; // the title-card capture does the talking about live/offline
    async function connect() {
      let url;
      try {
        url = await playlistUrl(name);
      } catch (error) {
        if (!quiet) log(name, `Kunne ikke hente streamen: ${error.message}. Prøver igen om 60 s.`);
        return setTimeout(connect, 60000);
      }
      if (!url) {
        if (!quiet) log(name, "Offline. Tjekker igen om 60 s.");
        return setTimeout(connect, 60000);
      }
      if (!quiet) log(name, "Live — læser titel-hjørnet nederst til højre og pausemenuen øverst til højre.");
      const crop = `crop=iw*${area.w}:ih*${area.h}:iw*${area.x}:ih*${area.y}`;
      const ff = spawn("ffmpeg", ["-loglevel", "error", "-i", url, "-vf", `fps=1/${seconds},${crop},scale=iw*2:-1`, "-f", "image2pipe", "-c:v", "png", "-"], { stdio: ["ignore", "pipe", "pipe"] });
      pipeFrames(ff, onPng, quiet, connect);
    }
    connect();
  }

  function pipeFrames(ff, onPng, quiet, reconnect) {
    let buf = Buffer.alloc(0);
    const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    ff.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let end;
      while ((end = buf.indexOf(IEND)) >= 0) {
        const png = buf.subarray(0, end + IEND.length);
        buf = buf.subarray(end + IEND.length);
        onPng(Buffer.from(png));
      }
    });
    ff.stderr.on("data", (d) => { const t = String(d).trim(); if (t && !quiet) log(name, `ffmpeg: ${t.slice(0, 200)}`); });
    ff.on("exit", () => {
      if (!quiet) log(name, "Streamen stoppede (offline eller ny adgang). Forbinder igen om 15 s.");
      setTimeout(reconnect, 15000);
    });
  }
  capture("title");
  capture("menu");
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
  const hints = loadHints();
  log("", `Forslag fra ord på skærmen: ${hints.length} stikord (vises kun i panelet, ændrer intet selv).`);
  for (const s of streams) runStream(s, ocr, hints);
}
