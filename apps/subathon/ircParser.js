// Reads the subscription lines Twitch chat sends as IRC USERNOTICE messages, e.g.
//   @badges=subscriber/6;display-name=Viewer;msg-id=resub;msg-param-sub-plan=1000;... :tmi.twitch.tv USERNOTICE #channel :text
// The functions only take a string, so they work the same on a line from the live
// connection and on one pasted into a test.

// Twitch's msg-id for each thing that counts as "somebody paid for a sub". Everything else
// (raids, giftpaidupgrade, anongiftpaidupgrade, primepaidupgrade, rituals, ...) is ignored:
// an upgrade is not a new payment and must not add time a second time.
const SUB_KINDS = new Map([
  ["sub", "sub"],
  ["resub", "resub"],
  ["subgift", "subgift"],
  ["anonsubgift", "subgift"],
  // The summary Twitch sends first when somebody gifts several subs at once. Each of the gifts
  // follows as its own subgift line, so the two have to be matched up (see createGiftTracker).
  ["submysterygift", "submysterygift"],
  ["anonsubmysterygift", "submysterygift"]
]);

const ANONYMOUS_GIFTER = "ananonymousgifter";
const MAX_MASS_GIFT = 1000;

// IRCv3 message-tags escaping: \: is ";", \s is a space, \\ is a backslash, \r and \n are line breaks.
function unescapeTag(value) {
  return value.replace(/\\(.?)/g, (_match, char) => {
    if (char === ":") return ";";
    if (char === "s") return " ";
    if (char === "r") return "\r";
    if (char === "n") return "\n";
    return char;
  });
}

/** Splits one IRC line into { tags, prefix, command, params }, or null when it is not a message. */
export function parseIrcLine(line) {
  if (typeof line !== "string") return null;
  let rest = line.replace(/[\r\n]+$/, "");
  const tags = {};

  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ");
    if (space < 0) return null;
    for (const pair of rest.slice(1, space).split(";")) {
      if (!pair) continue;
      const equals = pair.indexOf("=");
      if (equals < 0) tags[pair] = "";
      else tags[pair.slice(0, equals)] = unescapeTag(pair.slice(equals + 1));
    }
    rest = rest.slice(space + 1).trimStart();
  }

  let prefix = null;
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");
    if (space < 0) return null;
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1).trimStart();
  }

  let trailing = null;
  const trailingStart = rest.indexOf(" :");
  if (trailingStart >= 0) {
    trailing = rest.slice(trailingStart + 2);
    rest = rest.slice(0, trailingStart);
  }
  const params = rest.split(" ").filter(Boolean);
  const command = params.shift();
  if (!command) return null;
  if (trailing !== null) params.push(trailing);
  return { tags, prefix, command, params };
}

// 1000/2000/3000 are the tiers; "Prime" is a Twitch Prime sub, which pays out like tier 1.
export function tierOfPlan(plan) {
  if (plan === "2000") return 2;
  if (plan === "3000") return 3;
  return 1;
}

function wholeNumber(raw, fallback, max) {
  const value = Math.trunc(Number(raw));
  return Number.isFinite(value) && value >= 1 ? Math.min(value, max) : fallback;
}

/**
 * Turns one USERNOTICE line into a sub event, or null when the line is anything else
 * (another command, or a USERNOTICE that is not a paid sub).
 *
 * @returns {null | {
 *   id: string|null, kind: "sub"|"resub"|"subgift"|"submysterygift", channel: string,
 *   user: string, login: string, anonymous: boolean, tier: 1|2|3, prime: boolean,
 *   count: number, recipient: string|null, giftKeys: string[]
 * }}
 *   `count` is the number of subs the line stands for: the gift total for a submysterygift, otherwise 1.
 *   `giftKeys` are the ids that tie a bulk gift to the single gifts it consists of.
 */
export function parseUserNotice(input) {
  const line = typeof input === "string" ? parseIrcLine(input) : input;
  if (!line || line.command !== "USERNOTICE") return null;
  const tags = line.tags || {};
  const kind = SUB_KINDS.get(tags["msg-id"]);
  if (!kind) return null;

  const login = String(tags.login || "").toLowerCase();
  const anonymous = String(tags["msg-id"]).startsWith("anon") || login === ANONYMOUS_GIFTER;
  const plan = tags["msg-param-sub-plan"] || "";
  const giftKeys = [];
  if (kind === "subgift" || kind === "submysterygift") {
    if (tags["msg-param-origin-id"]) giftKeys.push(`o:${tags["msg-param-origin-id"]}`);
    if (tags["msg-param-community-gift-id"]) giftKeys.push(`c:${tags["msg-param-community-gift-id"]}`);
  }

  return {
    id: tags.id || null,
    kind,
    channel: String(line.params[0] || "").replace(/^#/, "").toLowerCase(),
    user: anonymous ? "Anonymous" : (tags["display-name"] || tags.login || "Unknown"),
    login,
    anonymous,
    tier: tierOfPlan(plan),
    prime: plan === "Prime",
    count: kind === "submysterygift" ? wholeNumber(tags["msg-param-mass-gift-count"], 1, MAX_MASS_GIFT) : 1,
    recipient: kind === "subgift" ? (tags["msg-param-recipient-display-name"] || tags["msg-param-recipient-user-name"] || null) : null,
    giftKeys
  };
}
