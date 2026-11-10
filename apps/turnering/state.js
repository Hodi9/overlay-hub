import crypto from "node:crypto";

// A knockout tournament: the entrants in seed order, and the result of every match that has been played.
// The bracket itself (who meets whom in which round) is never stored; it is worked out from those two.

export const ACCENTS = ["lime", "mint", "blue", "violet", "yellow", "pink", "white", "orange"];
export const MAX_ENTRANTS = 16;
export const BEST_OF = [0, 1, 3, 5, 7]; // 0 is a free score: the match is ended by hand
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;
const MAX_SCORE = 99;

const clip = (value, max) => String(value ?? "").trim().slice(0, max);

export const DEFAULT_PLAN = { title: "Turnering", subtitle: "", accent: "lime", scale: 1, bestOf: 3, lang: "da", live: "" };

export function cleanPlan(input, existing = DEFAULT_PLAN) {
  const scale = typeof input?.scale === "number" && Number.isFinite(input.scale) ? Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, input.scale)) * 100) / 100 : existing.scale;
  return {
    title: typeof input?.title === "string" ? clip(input.title, 40) : existing.title,
    subtitle: typeof input?.subtitle === "string" ? clip(input.subtitle, 50) : existing.subtitle,
    accent: ACCENTS.includes(input?.accent) ? input.accent : existing.accent,
    scale,
    bestOf: BEST_OF.includes(input?.bestOf) ? input.bestOf : existing.bestOf,
    lang: input?.lang === "da" || input?.lang === "en" ? input.lang : existing.lang,
    live: typeof input?.live === "string" ? clip(input.live, 12) : existing.live
  };
}

// An entrant is a team or a single player: a name, an optional line under it (the players, a country, a club)
// and an optional logo or picture. "logo" is the version of an uploaded picture and only the server changes it.
export const blankEntrant = (id = crypto.randomUUID()) => ({ id, name: "", tag: "", logo: "" });

export function cleanEntrant(input, existing = blankEntrant()) {
  const name = typeof input?.name === "string" ? clip(input.name, 28) : "";
  return {
    id: existing.id,
    name: name || existing.name,
    tag: typeof input?.tag === "string" ? clip(input.tag, 40) : existing.tag,
    logo: existing.logo || ""
  };
}

export function addEntrant(entrants, input) {
  const entrant = cleanEntrant(input);
  if (!entrant.name || entrants.length >= MAX_ENTRANTS) return null;
  return { entrants: [...entrants, entrant], entrant };
}

export function updateEntrant(entrants, id, patch) {
  const at = entrants.findIndex((entrant) => entrant.id === id);
  if (at === -1) return null;
  return entrants.map((entrant, i) => (i === at ? cleanEntrant(patch, entrant) : entrant));
}

export const removeEntrant = (entrants, id) => entrants.filter((entrant) => entrant.id !== id);

export function reorder(entrants, ids) {
  const byId = new Map(entrants.map((entrant) => [entrant.id, entrant]));
  const ordered = [...new Set(Array.isArray(ids) ? ids : [])].map((id) => byId.get(id)).filter(Boolean);
  for (const entrant of entrants) if (!ordered.includes(entrant)) ordered.push(entrant);
  return ordered;
}

// A random draw. "random" can be replaced in tests.
export function shuffle(entrants, random = Math.random) {
  const out = [...entrants];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 2, 4, 8 or 16 places: the smallest bracket everyone fits in.
export function bracketSize(count) {
  let size = 2;
  while (size < Math.min(count, MAX_ENTRANTS)) size *= 2;
  return size;
}

// The seeds in the order they stand in the first round: 1 meets the last, 2 meets the second last, and the two
// best only meet in the final. With fewer entrants than places, the best seeds get the free passes.
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const total = order.length * 2;
    order = order.flatMap((seed) => [seed, total + 1 - seed]);
  }
  return order;
}

export const matchId = (round, index) => `r${round}m${index}`;

// The whole bracket, round by round. Each match has the two entrants' ids (null while they are not known), the
// score, and the winner's id. A saved result only counts while the same two entrants are in the match: when an
// earlier match is changed, the matches after it start over.
export function buildBracket(entrants, results = {}) {
  const size = bracketSize(entrants.length);
  const slots = seedOrder(size).map((seed) => entrants[seed - 1]?.id ?? null);
  const rounds = [];
  for (let round = 0, count = size / 2; count >= 1; round++, count /= 2) {
    const matches = [];
    for (let index = 0; index < count; index++) {
      const id = matchId(round, index);
      const a = round === 0 ? slots[index * 2] : rounds[round - 1][index * 2].winner;
      const b = round === 0 ? slots[index * 2 + 1] : rounds[round - 1][index * 2 + 1].winner;
      // A free pass: only one entrant in a first-round match, who goes straight on.
      const bye = round === 0 && Boolean(a) !== Boolean(b);
      const saved = results?.[id];
      const valid = Boolean(a && b && saved && saved.ids?.[0] === a && saved.ids?.[1] === b);
      const winner = bye ? a || b : valid && saved.winner === "a" ? a : valid && saved.winner === "b" ? b : null;
      matches.push({ id, round, index, a, b, scoreA: valid ? saved.a : 0, scoreB: valid ? saved.b : 0, winner, bye, played: valid });
    }
    rounds.push(matches);
  }
  return rounds;
}

const allMatches = (rounds) => rounds.flat();

// Only the results that still belong to the bracket (see buildBracket).
export function pruneResults(entrants, results) {
  const kept = {};
  for (const match of allMatches(buildBracket(entrants, results))) if (match.played) kept[match.id] = results[match.id];
  return kept;
}

const score = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_SCORE, Math.max(0, Math.round(value))) : fallback);

// Changes one match: the score, and who won. With "best of" set, the match is decided on its own when one side
// reaches the wins needed (and opens again if the score is taken back); a winner in the patch ("a", "b" or ""
// to open the match again) always goes first, for a forfeit or a free score.
// Returns the new results, or null when the match does not have two entrants yet.
export function setResult(entrants, results, id, patch, bestOf = 0) {
  const match = allMatches(buildBracket(entrants, results)).find((candidate) => candidate.id === id);
  if (!match || !match.a || !match.b) return null;
  const a = score(patch?.a, match.scoreA);
  const b = score(patch?.b, match.scoreB);
  let winner = match.winner === match.a ? "a" : match.winner === match.b ? "b" : "";
  if (patch?.winner === "a" || patch?.winner === "b" || patch?.winner === "") winner = patch.winner;
  else if (bestOf > 0) {
    const need = Math.ceil(bestOf / 2);
    winner = a >= need && a > b ? "a" : b >= need && b > a ? "b" : "";
  }
  return pruneResults(entrants, { ...results, [id]: { ids: [match.a, match.b], a, b, winner } });
}

// The match the scoreboard shows: the one picked in the panel while it is still open, otherwise the next match
// that can be played. Empty when the tournament is over or has not got two entrants yet.
export function liveMatch(rounds, picked = "") {
  const open = allMatches(rounds).filter((match) => match.a && match.b && !match.winner);
  return (open.find((match) => match.id === picked) || open[0])?.id || "";
}

export const champion = (rounds) => rounds.at(-1)?.[0]?.winner || null;

// Reads what was saved in the database, tolerating anything that does not look right.
export function restore(saved) {
  const entrants = (Array.isArray(saved?.entrants) ? saved.entrants : [])
    .map((raw) => {
      const base = blankEntrant(typeof raw?.id === "string" && raw.id ? raw.id.slice(0, 64) : undefined);
      return cleanEntrant(raw, { ...base, logo: typeof raw?.logo === "string" ? raw.logo.slice(0, 16) : "" });
    })
    .filter((entrant) => entrant.name)
    .slice(0, MAX_ENTRANTS);
  const results = {};
  for (const [id, raw] of Object.entries(saved?.results && typeof saved.results === "object" ? saved.results : {})) {
    if (!Array.isArray(raw?.ids) || typeof raw.ids[0] !== "string" || typeof raw.ids[1] !== "string") continue;
    results[id] = { ids: [raw.ids[0], raw.ids[1]], a: score(raw.a, 0), b: score(raw.b, 0), winner: raw.winner === "a" || raw.winner === "b" ? raw.winner : "" };
  }
  return { plan: cleanPlan(saved?.plan), entrants, results: pruneResults(entrants, results) };
}
