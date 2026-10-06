// 7TV emotes aren't visible to Twitch, so chat only shows them as plain words.
// We download the channel's 7TV emote set (plus 7TV's global set) and count
// messages that contain those names. Ids are stored as "7tv:<id>" so the page
// knows which image host to use.
const API = "https://7tv.io/v3";
const REFRESH_MS = 10 * 60 * 1000;

export function createSevenTv({ fetchImpl = fetch, log = console } = {}) {
  let names = new Map(); // emote name -> 7tv id
  const status = { loaded: false, count: 0, lastError: null, lastLoadedAt: null };
  let timer = null, twitchId = null;

  async function getJson(url) {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }

  async function load() {
    try {
      const next = new Map();
      // Global first, so a channel emote with the same name wins.
      const global = await getJson(`${API}/emote-sets/global`).catch((e) => { log.warn?.("subathon: 7TV global set failed.", e.message); return null; });
      for (const e of global?.emotes || []) if (e?.id && e?.name) next.set(e.name, e.id);
      if (twitchId) {
        const user = await getJson(`${API}/users/twitch/${encodeURIComponent(twitchId)}`);
        for (const e of user?.emote_set?.emotes || []) if (e?.id && e?.name) next.set(e.name, e.id);
      }
      names = next;
      Object.assign(status, { loaded: true, count: next.size, lastError: null, lastLoadedAt: new Date().toISOString() });
    } catch (error) {
      status.lastError = String(error.message || error);
      log.warn?.("subathon: could not load 7TV emotes, will retry.", status.lastError);
    }
  }

  // Called once the channel's Twitch user id is known (from the chat connection).
  function start(id) {
    if (twitchId === String(id)) return;
    twitchId = String(id);
    load();
    clearInterval(timer);
    timer = setInterval(load, REFRESH_MS);
    timer.unref?.();
  }

  // Emotes in `text` that are 7TV emotes. `skip` holds names already counted
  // as Twitch emotes, so a name that exists on both is not counted twice.
  function match(text, skip = new Set()) {
    if (!names.size) return [];
    const out = [];
    for (const word of String(text).split(/\s+/)) {
      const id = names.get(word);
      if (id && !skip.has(word)) out.push({ id: `7tv:${id}`, name: word });
    }
    return out;
  }

  return { start, load, match, status, _setNames: (m) => { names = m; } };
}
