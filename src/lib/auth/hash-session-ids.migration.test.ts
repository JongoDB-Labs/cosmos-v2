// @vitest-environment node
//
// The 20261114180000_hash_session_ids migration hashes the session ids stored
// before ids were stored hashed, in place, so the cookies already issued keep
// signing in. Proven by running the real migration.sql against copies of the
// two tables in a scratch schema, inside a transaction that is rolled back: the
// shared test database's own sessions are never touched, so nothing another
// spec is signed in with changes under it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { sessionRowId } from "./session-id";

const MIGRATION_SQL = readFileSync(
  path.join(process.cwd(), "prisma/migrations/20261114180000_hash_session_ids/migration.sql"),
  "utf8",
);

// The app's own shape, the dev script's (a uuid), and three a bytea cast would
// misread or refuse: a backslash, a "\x" prefix, and text beyond ASCII.
const TOKENS = ["a".repeat(32) + "0123456789abcdef".repeat(2), "3f2b8e0c-6d1a-4f5e-9b7c-2a4d6e8f0b1c", "a\\b", "\\x41", "jeton-été"];

let client: pg.Client;

beforeEach(async () => {
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const schema = `sesshash_${Math.random().toString(36).slice(2, 10)}`;
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`CREATE TABLE ${schema}.sessions (LIKE public.sessions INCLUDING ALL)`);
  await client.query(`CREATE TABLE ${schema}.session_records (LIKE public.session_records INCLUDING ALL)`);
  // The migration names its tables unqualified, so it lands on these copies.
  await client.query(`SET LOCAL search_path = ${schema}`);
});

afterEach(async () => {
  await client.query("ROLLBACK");
  await client.end();
});

async function seedRaw() {
  for (const token of TOKENS) {
    await client.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, gen_random_uuid(), now() + interval '1 day')`,
      [token],
    );
    await client.query(
      `INSERT INTO session_records (org_id, user_id, session_token, expires_at) VALUES (gen_random_uuid(), gen_random_uuid(), $1, now() + interval '1 day')`,
      [token],
    );
  }
}

const ids = async () => (await client.query<{ id: string }>(`SELECT id FROM sessions ORDER BY id`)).rows.map((r) => r.id).sort();
const recordTokens = async () =>
  (await client.query<{ t: string }>(`SELECT session_token AS t FROM session_records`)).rows.map((r) => r.t).sort();

describe("hash_session_ids", () => {
  it("is one statement, so `prisma migrate deploy` cannot commit half of it", () => {
    // migrate deploy splits a file into statements and sends each outside a
    // transaction (see 20261024070000_cql_indexes). Two statements here could
    // leave the sessions hashed and their records not. One DO block applies
    // whole or not at all.
    const code = MIGRATION_SQL.replace(/--[^\n]*/g, "").trim();
    expect(code.startsWith("DO $$")).toBe(true);
    expect(code.endsWith("END $$;")).toBe(true);
    expect(code.split("$$")).toHaveLength(3);
  });

  it("replaces every stored session id with the id the app now looks it up by", async () => {
    await seedRaw();
    // Positive control: the raw rows are there before the migration runs.
    expect(await ids()).toEqual([...TOKENS].sort());

    await client.query(MIGRATION_SQL);

    expect(await ids()).toEqual(TOKENS.map(sessionRowId).sort());
    for (const token of TOKENS) expect(await ids()).not.toContain(token);
  });

  it("does the same to a session record's token, so it still names its session", async () => {
    await seedRaw();
    expect(await recordTokens()).toEqual([...TOKENS].sort());

    await client.query(MIGRATION_SQL);

    expect(await recordTokens()).toEqual(TOKENS.map(sessionRowId).sort());
    expect(await recordTokens()).toEqual(await ids());
  });
});
