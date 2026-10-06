import pg from "pg";

// Hourly buckets: chat per user, sub/gift/bits events per user, and emote
// counts. Postgres when DATABASE_URL is set (needed on hosts with an
// ephemeral disk), otherwise memory (lost on restart).
export function createStore({ channel, databaseUrl }) {
  if (!databaseUrl) return createMemoryStore();
  const { Pool } = pg;
  const db = new Pool({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false }
  });
  const iso = (ms) => new Date(ms).toISOString();
  const bounds = (from, to) => [from == null ? null : iso(from), to == null ? null : iso(to)];

  return {
    persistent: true,
    async init() {
      await db.query(`
        CREATE TABLE IF NOT EXISTS subathon_hourly (
          channel TEXT NOT NULL,
          hour TIMESTAMPTZ NOT NULL,
          username TEXT NOT NULL,
          display TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT '',
          messages INT NOT NULL DEFAULT 0,
          words INT NOT NULL DEFAULT 0,
          chars INT NOT NULL DEFAULT 0,
          emotes INT NOT NULL DEFAULT 0,
          PRIMARY KEY (channel, hour, username)
        )
      `);
      await db.query(`ALTER TABLE subathon_hourly ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT ''`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS subathon_events (
          channel TEXT NOT NULL,
          hour TIMESTAMPTZ NOT NULL,
          kind TEXT NOT NULL,
          username TEXT NOT NULL,
          display TEXT NOT NULL,
          amount INT NOT NULL DEFAULT 0,
          PRIMARY KEY (channel, hour, kind, username)
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS subathon_emotes (
          channel TEXT NOT NULL,
          hour TIMESTAMPTZ NOT NULL,
          emote TEXT NOT NULL,
          emote_id TEXT NOT NULL,
          count INT NOT NULL DEFAULT 0,
          PRIMARY KEY (channel, hour, emote)
        )
      `);
    },
    async addChat(rows) {
      if (!rows.length) return;
      await db.query(
        `INSERT INTO subathon_hourly (channel, hour, username, display, role, messages, words, chars, emotes)
         SELECT $1::text, t.hour, t.username, t.display, t.role, t.messages, t.words, t.chars, t.emotes
         FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[], $9::int[])
           AS t(hour, username, display, role, messages, words, chars, emotes)
         ON CONFLICT (channel, hour, username) DO UPDATE SET
           display = EXCLUDED.display,
           role = EXCLUDED.role,
           messages = subathon_hourly.messages + EXCLUDED.messages,
           words = subathon_hourly.words + EXCLUDED.words,
           chars = subathon_hourly.chars + EXCLUDED.chars,
           emotes = subathon_hourly.emotes + EXCLUDED.emotes`,
        [channel, rows.map((r) => iso(r.hour)), rows.map((r) => r.username), rows.map((r) => r.display), rows.map((r) => r.role || ""),
          rows.map((r) => r.messages), rows.map((r) => r.words), rows.map((r) => r.chars), rows.map((r) => r.emotes)]
      );
    },
    async addEvents(rows) {
      if (!rows.length) return;
      await db.query(
        `INSERT INTO subathon_events (channel, hour, kind, username, display, amount)
         SELECT $1::text, t.hour, t.kind, t.username, t.display, t.amount
         FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::int[])
           AS t(hour, kind, username, display, amount)
         ON CONFLICT (channel, hour, kind, username) DO UPDATE SET
           display = EXCLUDED.display,
           amount = subathon_events.amount + EXCLUDED.amount`,
        [channel, rows.map((r) => iso(r.hour)), rows.map((r) => r.kind), rows.map((r) => r.username), rows.map((r) => r.display), rows.map((r) => r.amount)]
      );
    },
    async addEmotes(rows) {
      if (!rows.length) return;
      await db.query(
        `INSERT INTO subathon_emotes (channel, hour, emote, emote_id, count)
         SELECT $1::text, t.hour, t.emote, t.emote_id, t.count
         FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::int[])
           AS t(hour, emote, emote_id, count)
         ON CONFLICT (channel, hour, emote) DO UPDATE SET
           count = subathon_emotes.count + EXCLUDED.count`,
        [channel, rows.map((r) => iso(r.hour)), rows.map((r) => r.emote), rows.map((r) => r.emoteId), rows.map((r) => r.count)]
      );
    },
    async chatRows(from, to) {
      const result = await db.query(
        `SELECT (EXTRACT(EPOCH FROM hour) * 1000)::float8 AS hour, username, display, role, messages, words, chars, emotes
         FROM subathon_hourly
         WHERE channel = $1 AND ($2::timestamptz IS NULL OR hour >= $2) AND ($3::timestamptz IS NULL OR hour < $3)`,
        [channel, ...bounds(from, to)]
      );
      return result.rows;
    },
    async eventRows(from, to) {
      const result = await db.query(
        `SELECT (EXTRACT(EPOCH FROM hour) * 1000)::float8 AS hour, kind, username, display, amount
         FROM subathon_events
         WHERE channel = $1 AND ($2::timestamptz IS NULL OR hour >= $2) AND ($3::timestamptz IS NULL OR hour < $3)`,
        [channel, ...bounds(from, to)]
      );
      return result.rows;
    },
    async emoteRows(from, to) {
      const result = await db.query(
        `SELECT (EXTRACT(EPOCH FROM hour) * 1000)::float8 AS hour, emote, emote_id AS "emoteId", count
         FROM subathon_emotes
         WHERE channel = $1 AND ($2::timestamptz IS NULL OR hour >= $2) AND ($3::timestamptz IS NULL OR hour < $3)`,
        [channel, ...bounds(from, to)]
      );
      return result.rows;
    },
    async close() { await db.end(); }
  };
}

function createMemoryStore() {
  const chat = new Map(), events = new Map(), emotes = new Map();
  const within = (from, to) => (r) => (from == null || r.hour >= from) && (to == null || r.hour < to);
  function upsert(map, key, row, add) {
    const cur = map.get(key);
    if (!cur) map.set(key, { ...row });
    else add(cur);
  }
  return {
    persistent: false,
    async init() {},
    async addChat(rows) {
      for (const r of rows) upsert(chat, `${r.hour}|${r.username}`, r, (c) => {
        c.display = r.display; c.role = r.role || "";
        c.messages += r.messages; c.words += r.words; c.chars += r.chars; c.emotes += r.emotes;
      });
    },
    async addEvents(rows) {
      for (const r of rows) upsert(events, `${r.hour}|${r.kind}|${r.username}`, r, (c) => { c.display = r.display; c.amount += r.amount; });
    },
    async addEmotes(rows) {
      for (const r of rows) upsert(emotes, `${r.hour}|${r.emote}`, r, (c) => { c.count += r.count; });
    },
    async chatRows(from, to) { return [...chat.values()].filter(within(from, to)); },
    async eventRows(from, to) { return [...events.values()].filter(within(from, to)); },
    async emoteRows(from, to) { return [...emotes.values()].filter(within(from, to)); },
    async close() {}
  };
}
