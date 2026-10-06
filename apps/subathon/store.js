import pg from "pg";

// Hourly per-user buckets. Postgres when DATABASE_URL is set (needed on
// hosts with an ephemeral disk), otherwise memory (lost on restart).
export function createStore({ channel, databaseUrl }) {
  if (!databaseUrl) return createMemoryStore();
  const { Pool } = pg;
  const db = new Pool({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false }
  });
  return {
    persistent: true,
    async init() {
      await db.query(`
        CREATE TABLE IF NOT EXISTS subathon_hourly (
          channel TEXT NOT NULL,
          hour TIMESTAMPTZ NOT NULL,
          username TEXT NOT NULL,
          display TEXT NOT NULL,
          messages INT NOT NULL DEFAULT 0,
          words INT NOT NULL DEFAULT 0,
          chars INT NOT NULL DEFAULT 0,
          emotes INT NOT NULL DEFAULT 0,
          PRIMARY KEY (channel, hour, username)
        )
      `);
    },
    async add(rows) {
      if (!rows.length) return;
      await db.query(
        `INSERT INTO subathon_hourly (channel, hour, username, display, messages, words, chars, emotes)
         SELECT $1::text, t.hour, t.username, t.display, t.messages, t.words, t.chars, t.emotes
         FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::int[])
           AS t(hour, username, display, messages, words, chars, emotes)
         ON CONFLICT (channel, hour, username) DO UPDATE SET
           display = EXCLUDED.display,
           messages = subathon_hourly.messages + EXCLUDED.messages,
           words = subathon_hourly.words + EXCLUDED.words,
           chars = subathon_hourly.chars + EXCLUDED.chars,
           emotes = subathon_hourly.emotes + EXCLUDED.emotes`,
        [
          channel,
          rows.map((r) => new Date(r.hour).toISOString()),
          rows.map((r) => r.username),
          rows.map((r) => r.display),
          rows.map((r) => r.messages),
          rows.map((r) => r.words),
          rows.map((r) => r.chars),
          rows.map((r) => r.emotes)
        ]
      );
    },
    async rows(fromHourMs, toMs) {
      const result = await db.query(
        `SELECT (EXTRACT(EPOCH FROM hour) * 1000)::float8 AS hour, username, display, messages, words, chars, emotes
         FROM subathon_hourly
         WHERE channel = $1
           AND ($2::timestamptz IS NULL OR hour >= $2)
           AND ($3::timestamptz IS NULL OR hour < $3)`,
        [channel, fromHourMs == null ? null : new Date(fromHourMs).toISOString(), toMs == null ? null : new Date(toMs).toISOString()]
      );
      return result.rows;
    },
    async close() { await db.end(); }
  };
}

function createMemoryStore() {
  const data = new Map();
  return {
    persistent: false,
    async init() {},
    async add(rows) {
      for (const r of rows) {
        const key = `${r.hour}|${r.username}`;
        const cur = data.get(key);
        if (!cur) { data.set(key, { ...r }); continue; }
        cur.display = r.display;
        cur.messages += r.messages; cur.words += r.words; cur.chars += r.chars; cur.emotes += r.emotes;
      }
    },
    async rows(fromHourMs, toMs) {
      return [...data.values()].filter((r) => (fromHourMs == null || r.hour >= fromHourMs) && (toMs == null || r.hour < toMs));
    },
    async close() {}
  };
}
