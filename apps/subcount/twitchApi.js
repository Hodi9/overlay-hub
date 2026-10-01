// Minimal Twitch OAuth + Helix client. `fetchImpl` is injectable for tests.
const AUTH_URL = "https://id.twitch.tv/oauth2";
const HELIX_URL = "https://api.twitch.tv/helix";
export const SCOPE = "channel:read:subscriptions";

export function createTwitchApi({ clientId, clientSecret, fetchImpl = fetch }) {
  async function tokenRequest(params) {
    const response = await fetchImpl(`${AUTH_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      const error = new Error(`Twitch token request failed (${response.status}): ${body.message || "unknown error"}`);
      error.status = response.status;
      throw error;
    }
    return { accessToken: body.access_token, refreshToken: body.refresh_token };
  }

  async function helix(pathAndQuery, accessToken) {
    const response = await fetchImpl(`${HELIX_URL}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Twitch API ${pathAndQuery} failed (${response.status}): ${body.message || "unknown error"}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  return {
    authorizeUrl: (redirectUri, state) =>
      `${AUTH_URL}/authorize?${new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE, state
      })}`,
    exchangeCode: (code, redirectUri) =>
      tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri }),
    refresh: (refreshToken) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),
    async getSelf(accessToken) {
      const user = (await helix("/users", accessToken)).data?.[0];
      if (!user) throw new Error("Twitch returned no user for this token.");
      return { id: user.id, login: user.login };
    },
    async getSubTotal(broadcasterId, accessToken) {
      const body = await helix(`/subscriptions?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=1`, accessToken);
      return Number(body.total) || 0;
    }
  };
}
