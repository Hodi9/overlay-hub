import { parseDecapiUptime } from "./logic.js";

// Is a Twitch channel live, and since when? Returns { live, startedAt (ISO or null), source }.
//
// With TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET (a free app from dev.twitch.tv/console) it asks Twitch's official
// Helix API, which gives the exact start time. Without them it asks decapi.me, a public no-key service whose uptime
// text is turned back into a start time (to the second).
export function createStatusChecker({ fetchImpl = fetch, clientId = process.env.TWITCH_CLIENT_ID || "", clientSecret = process.env.TWITCH_CLIENT_SECRET || "" } = {}) {
  let token = null;
  let tokenExpiresAt = 0;

  async function appToken() {
    if (token && Date.now() < tokenExpiresAt - 60000) return token;
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" });
    const response = await fetchImpl("https://id.twitch.tv/oauth2/token", { method: "POST", body, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Twitch-login fejlede (${response.status}). Tjek TWITCH_CLIENT_ID/SECRET.`);
    const data = await response.json();
    token = data.access_token;
    tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return token;
  }

  async function viaHelix(channel) {
    const call = async () => fetchImpl(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`, {
      headers: { "Client-Id": clientId, Authorization: `Bearer ${await appToken()}` },
      signal: AbortSignal.timeout(10000)
    });
    let response = await call();
    if (response.status === 401) { token = null; response = await call(); }
    if (!response.ok) throw new Error(`Twitch svarede ${response.status}.`);
    const stream = (await response.json()).data?.find((s) => s.type === "live");
    return { live: Boolean(stream), startedAt: stream?.started_at || null, source: "twitch" };
  }

  async function viaDecapi(channel) {
    const response = await fetchImpl(`https://decapi.me/twitch/uptime/${encodeURIComponent(channel)}?offline_msg=OFFLINE&precision=4`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`decapi svarede ${response.status}.`);
    const uptime = parseDecapiUptime(await response.text());
    if (uptime === null) return { live: false, startedAt: null, source: "decapi" };
    return { live: true, startedAt: new Date(Date.now() - uptime).toISOString(), source: "decapi" };
  }

  const useHelix = Boolean(clientId && clientSecret);
  return { check: (channel) => (useHelix ? viaHelix(channel) : viaDecapi(channel)), source: useHelix ? "twitch" : "decapi" };
}
