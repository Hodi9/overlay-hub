import tmi from "tmi.js";

const isModOrBroadcaster = (tags) =>
  tags.badges?.broadcaster === "1" || Boolean(tags.mod) || String(tags["user-type"] || "").toLowerCase() === "mod";

// Anonymous, read-only Twitch chat (no bot account or OAuth). Follows one channel at a time and passes on messages
// from the broadcaster and moderators only, so viewers cannot run up the counters.
export function createChatListener({ onMessage, log = console }) {
  const client = new tmi.Client({ connection: { reconnect: true, secure: true } });
  let connecting = null;
  let current = "";

  client.on("message", (channelWithHash, tags, message, self) => {
    if (self || !isModOrBroadcaster(tags)) return;
    const channel = channelWithHash.replace(/^#/, "").toLowerCase();
    if (channel !== current) return;
    onMessage(message, tags["display-name"] || tags.username || "ukendt");
  });

  const connect = () => {
    if (!connecting) {
      connecting = client.connect().catch((error) => {
        connecting = null;
        throw error;
      });
    }
    return connecting;
  };

  // "" leaves chat. Errors are logged, not thrown: the panel still works without chat.
  async function follow(channel) {
    const previous = current;
    current = channel;
    try {
      if (previous && previous !== channel) await client.part(previous).catch(() => {});
      if (channel) {
        await connect();
        await client.join(channel);
      }
      return true;
    } catch (error) {
      log.error(`gta6-counters: kunne ikke følge #${channel} i chatten.`, error);
      return false;
    }
  }

  return { follow, channel: () => current };
}
