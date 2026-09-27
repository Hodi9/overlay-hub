import tmi from "tmi.js";

function isAuthorized(tags) {
  if (tags.badges?.broadcaster === "1") return true;
  if (tags.mod) return true;
  if (String(tags["user-type"] || "").toLowerCase() === "mod") return true;
  return false;
}

// One shared, anonymous (read-only, no bot account/OAuth needed) Twitch IRC
// connection that joins channels on demand as different people request their
// own counter — so any number of channels can share this same hub without
// pre-registering anything. Only the broadcaster or a moderator of the
// channel the command was typed in can trigger that channel's counter.
export function createTwitchDeathHub({ command }) {
  const client = new tmi.Client({ connection: { reconnect: true, secure: true } });
  const joined = new Set();
  const listeners = new Set();
  let connectPromise = null;

  function ensureConnected() {
    if (!connectPromise) {
      connectPromise = client.connect().catch((error) => {
        console.error("rdr2-deaths: Twitch chat connection failed.", error);
        connectPromise = null;
        throw error;
      });
    }
    return connectPromise;
  }

  async function ensureJoined(channel) {
    if (joined.has(channel)) return;
    try {
      await ensureConnected();
      await client.join(channel);
      joined.add(channel);
    } catch (error) {
      console.error(`rdr2-deaths: could not join #${channel}.`, error);
    }
  }

  client.on("message", (channelWithHash, tags, message, self) => {
    if (self) return;
    if (message.trim().toLowerCase() !== command) return;
    if (!isAuthorized(tags)) return;
    const channel = channelWithHash.replace(/^#/, "").toLowerCase();
    const username = tags["display-name"] || tags.username || "ukendt";
    for (const listener of listeners) listener(channel, username);
  });

  return {
    ensureJoined,
    isJoined: (channel) => joined.has(channel),
    onDeath: (fn) => listeners.add(fn)
  };
}
