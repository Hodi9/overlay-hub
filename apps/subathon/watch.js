import crypto from "node:crypto";

// Watchtime: while the stream is live, ask Twitch once a minute who is
// connected to chat (lurkers included) and add that time to each of them.
// Needs a Twitch app (client id + secret) and a one-time approval from the
// streamer or a moderator with the moderator:read:chatters scope.
const ID = "https://id.twitch.tv/oauth2";
const HELIX = "https://api.twitch.tv/helix";
const SCOPE = "moderator:read:chatters";
const TICK_MS = 60_000;
const STATE_TTL_MS = 6 * 3600_000;

export function createWatchtime({ clientId, clientSecret, store, onPresent, fetchImpl = fetch, now = () => Date.now(), log = console }) {
  const enabled = Boolean(clientId && clientSecret);
  const status = { enabled, connected: false, login: null, live: false, chattersNow: 0, lastTickAt: null, lastError: null };
  let auth = null; // { refreshToken, accessToken, expiresAt, userId, login }
  let broadcasterId = null, timer = null, lastTickMs = null, ticking = false;
  const pendingStates = new Map(); // nonce -> expiry

  async function call(url, options = {}) {
    const res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { ok: res.ok, status: res.status, body };
  }

  async function tokenRequest(params) {
    const r = await call(`${ID}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }).toString()
    });
    if (!r.ok || !r.body?.access_token) throw new Error(`Twitch token request failed (${r.status})`);
    return r.body;
  }

  async function saveAuth(tokens, extra = {}) {
    auth = {
      ...auth, ...extra,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || auth?.refreshToken,
      expiresAt: now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000
    };
    await store.setAuth({ refreshToken: auth.refreshToken, userId: auth.userId, login: auth.login });
    status.connected = true;
    status.login = auth.login;
  }

  async function ensureToken(force = false) {
    if (!auth?.refreshToken) throw new Error("Not connected to Twitch");
    if (!force && auth.accessToken && auth.expiresAt - now() > 5 * 60_000) return auth.accessToken;
    const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refreshToken });
    await saveAuth(tokens);
    return auth.accessToken;
  }

  async function helix(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await ensureToken(attempt === 1);
      const r = await call(`${HELIX}${path}`, { headers: { authorization: `Bearer ${token}`, "client-id": clientId } });
      if (r.status !== 401) return r;
    }
    throw new Error("Twitch rejected the saved login (401). Connect again.");
  }

  async function listChatters() {
    const out = [];
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const q = `?broadcaster_id=${encodeURIComponent(broadcasterId)}&moderator_id=${encodeURIComponent(auth.userId)}&first=1000${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
      const r = await helix(`/chat/chatters${q}`);
      if (r.status === 403) throw new Error("This Twitch account is not the broadcaster or a moderator of the channel, or the permission is missing.");
      if (!r.ok) throw new Error(`Chatters request failed (${r.status})`);
      for (const c of r.body?.data || []) out.push({ username: String(c.user_login).toLowerCase(), display: c.user_name || c.user_login });
      cursor = r.body?.pagination?.cursor;
      if (!cursor) break;
    }
    return out;
  }

  async function tick() {
    if (!enabled || !status.connected || !broadcasterId || ticking) return;
    ticking = true;
    try {
      const live = await helix(`/streams?user_id=${encodeURIComponent(broadcasterId)}`);
      if (!live.ok) throw new Error(`Stream status request failed (${live.status})`);
      status.live = Boolean(live.body?.data?.length);
      if (!status.live) { lastTickMs = null; status.chattersNow = 0; status.lastError = null; return; }

      const chatters = await listChatters();
      const at = now();
      const seconds = lastTickMs == null ? TICK_MS / 1000 : Math.min(120, Math.max(1, Math.round((at - lastTickMs) / 1000)));
      lastTickMs = at;
      for (const c of chatters) onPresent({ ...c, seconds, at });
      status.chattersNow = chatters.length;
      status.lastTickAt = new Date(at).toISOString();
      status.lastError = null;
    } catch (error) {
      status.lastError = String(error.message || error);
      log.warn?.("subathon: watchtime check failed.", status.lastError);
    } finally {
      ticking = false;
    }
  }

  function startTimer() {
    if (timer || !enabled) return;
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    tick();
  }

  // Called with the channel's Twitch user id once chat is connected.
  function start(id) {
    broadcasterId = String(id);
    if (status.connected) startTimer();
  }

  async function init() {
    if (!enabled) return;
    try {
      const saved = await store.getAuth();
      if (saved?.refreshToken) {
        auth = { refreshToken: saved.refreshToken, userId: saved.userId, login: saved.login };
        status.connected = true;
        status.login = saved.login;
        if (broadcasterId) startTimer();
      }
    } catch (error) {
      status.lastError = String(error.message || error);
    }
  }

  // A link for the streamer (or a mod). The state nonce makes the callback
  // unguessable and single-use.
  function connectUrl(redirectUri) {
    const state = crypto.randomBytes(24).toString("hex");
    pendingStates.set(state, now() + STATE_TTL_MS);
    for (const [k, exp] of pendingStates) if (exp < now()) pendingStates.delete(k);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPE, state, force_verify: "true" });
    return `${ID}/authorize?${q}`;
  }

  async function handleCallback({ code, state, redirectUri }) {
    const expiry = pendingStates.get(String(state));
    pendingStates.delete(String(state));
    if (!enabled || !expiry || expiry < now()) throw new Error("This connection link has expired or was already used. Ask for a new one.");
    if (!code) throw new Error("Twitch did not return an approval.");
    const tokens = await tokenRequest({ grant_type: "authorization_code", code: String(code), redirect_uri: redirectUri });
    const v = await call(`${ID}/validate`, { headers: { authorization: `OAuth ${tokens.access_token}` } });
    if (!v.ok || !v.body?.user_id) throw new Error("Could not verify the Twitch login.");
    if (!(v.body.scopes || []).includes(SCOPE)) throw new Error("The permission to see who is in chat was not granted.");
    await saveAuth(tokens, { userId: String(v.body.user_id), login: String(v.body.login || "") });
    status.lastError = null;
    if (broadcasterId) startTimer();
    return status.login;
  }

  return { enabled, status, init, start, tick, connectUrl, handleCallback, SCOPE };
}
