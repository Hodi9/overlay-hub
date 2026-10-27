import tmi from "tmi.js";
import { parseUserNotice } from "./ircParser.js";

const SEEN_LIMIT = 500;

// One shared, anonymous (read-only, no login or Twitch app needed) chat connection that joins a
// channel when somebody asks for it, like the death counter's (apps/rdr2-deaths/twitchChat.js).
// tmi.js keeps the connection alive; the sub lines themselves are read from the raw IRC text so
// that the parsing is ours (ircParser.js) and does not depend on how tmi.js reshapes the tags.
export function createTwitchSubHub({ client = new tmi.Client({ connection: { reconnect: true, secure: true } }) } = {}) {
  const joined = new Set();
  const listeners = new Set();
  const seen = new Set(); // ids of lines already handled, in case the same line is delivered twice
  let connectPromise = null;

  function ensureConnected() {
    if (!connectPromise) {
      connectPromise = client.connect().catch((error) => {
        console.error("subathon: Twitch chat connection failed.", error);
        connectPromise = null;
        throw error;
      });
    }
    return connectPromise;
  }

  async function ensureJoined(channel) {
    if (joined.has(channel)) return true;
    try {
      await ensureConnected();
      await client.join(channel);
      joined.add(channel);
      return true;
    } catch (error) {
      console.error(`subathon: could not join #${channel}.`, error);
      return false;
    }
  }

  function remember(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
    return true;
  }

  client.on("raw_message", (_copy, message) => {
    if (message?.command !== "USERNOTICE") return;
    const event = parseUserNotice(message.raw);
    if (!event || !event.channel) return;
    if (event.id && !remember(event.id)) return;
    for (const listener of listeners) listener(event.channel, event);
  });

  return {
    ensureJoined,
    isJoined: (channel) => joined.has(channel),
    onSub: (listener) => listeners.add(listener)
  };
}
