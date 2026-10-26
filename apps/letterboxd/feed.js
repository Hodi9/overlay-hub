// Læser Letterboxds offentlige RSS-feed (letterboxd.com/<bruger>/rss/) og gør det til en simpel liste.
// Feedet har kun de seneste dagbogsindlæg, og kun film — Letterboxd har (endnu) ikke tv-serier.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function unwrapCdata(text) {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text);
  return match ? match[1] : text;
}

function tag(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`).exec(xml);
  return match ? match[1] : null;
}

// Letterboxd giver 0,5–5 stjerner; siden bruger 1–10 ligesom spil-ratings.
export function starsToScore(stars) {
  return Number.isFinite(stars) && stars >= 0.5 && stars <= 5 ? Math.round(stars * 2 * 10) / 10 : null;
}

function plainText(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value) ? value : null;
}

export function parseFeed(xml) {
  const films = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let item;
  while ((item = itemPattern.exec(String(xml || "")))) {
    const body = item[1];
    const rawTitle = tag(body, "letterboxd:filmTitle");
    if (rawTitle === null) continue; // fx lister, som ikke er en film

    const description = unwrapCdata(tag(body, "description") || "");
    const poster = safeUrl(decode((/<img[^>]*\ssrc="([^"]+)"/i.exec(description) || [])[1] || ""));
    let note = plainText(description.replace(/<p>\s*<img[^>]*>\s*<\/p>/i, ""));
    // Uden en anmeldelse skriver Letterboxd bare "Watched on Wednesday October 28, 2026." — det er ikke en note.
    if (/^Watched on [A-Za-z]+ [A-Za-z]+ \d{1,2}, \d{4}\.?$/.test(note)) note = "";

    const stars = Number(tag(body, "letterboxd:memberRating"));
    const year = Number(tag(body, "letterboxd:filmYear"));
    const watchedDate = (tag(body, "letterboxd:watchedDate") || "").trim();

    films.push({
      id: unwrapCdata(tag(body, "guid") || "").trim(),
      title: decode(unwrapCdata(rawTitle)).trim(),
      year: Number.isInteger(year) && year > 0 ? year : null,
      stars: Number.isFinite(stars) && tag(body, "letterboxd:memberRating") !== null ? stars : null,
      score: starsToScore(stars),
      liked: (tag(body, "letterboxd:memberLike") || "").trim() === "Yes",
      rewatch: (tag(body, "letterboxd:rewatch") || "").trim() === "Yes",
      watchedDate: /^\d{4}-\d{2}-\d{2}$/.test(watchedDate) ? watchedDate : null,
      url: safeUrl(decode(unwrapCdata(tag(body, "link") || "")).trim()),
      poster,
      note
    });
  }

  // Nyeste først: dagen man så den, og ved samme dag rækkefølgen i feedet (der er nyeste først).
  return films
    .map((film, index) => ({ film, index }))
    .sort((a, b) => (b.film.watchedDate || "").localeCompare(a.film.watchedDate || "") || a.index - b.index)
    .map(({ film }) => film);
}
