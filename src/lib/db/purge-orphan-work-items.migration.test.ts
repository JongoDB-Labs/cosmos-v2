// @vitest-environment node
//
// Effect of the 20261110200000_purge_orphan_work_items migration, proven by
// applying the real migration.sql to the real e2e database in the state a
// long-lived database is actually in: the two work_items foreign keys still
// NOT VALID, and an item left behind by a project deleted before they existed.
//
// A fresh database never had such an item, so its constraints were validated
// on creation. Each test therefore rebuilds that state inside a transaction —
// re-adds the constraints NOT VALID, exactly as 20261023230000 did — and rolls
// back, leaving the shared database as it found it.
//
// Every row a test asserts on is one it made itself, in the seeded test-org:
// CI seeds only a global built-in work-item type and no items, so borrowing
// "any org's type" or "any item" finds nothing there.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const MIGRATION_SQL = readFileSync(
  path.join(process.cwd(), "prisma/migrations/20261110200000_purge_orphan_work_items/migration.sql"),
  "utf8",
);

const FKS = ["work_items_project_id_fkey", "work_items_project_id_column_key_fkey"];

/** audit_logs_hash_chain()'s lock (20260606070000_audit_hash_chain). */
const AUDIT_CHAIN_LOCK = 491000001;

let client: pg.Client;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await client.query(sql, params)).rows[0] as T;
}

const countOf = async (sql: string, params: unknown[] = []) =>
  (await one<{ c: number }>(`SELECT count(*)::int AS c FROM ${sql}`, params)).c;

/**
 * This file does DDL on the shared test database while the rest of the unit
 * suite runs against it in parallel. Dropping a work_items foreign key takes
 * ACCESS EXCLUSIVE on work_items, projects and workflow_statuses, and the
 * migration's audit row takes the hash-chain lock. Taken one at a time, while
 * another test holds them in the other order, that can deadlock -- and Postgres
 * ends a deadlock by failing whichever transaction notices it, which may be
 * another file's. So all of them are taken up front and never waited for
 * (try-lock, NOWAIT), and if any is busy the test rolls back and tries again.
 *
 * After that it can still wait, briefly: its inserts' foreign-key checks lock
 * the seeded org, user and type rows, and the cascades take ordinary row
 * locks. Nothing in the suite holds those in a way that could close a cycle
 * today; lock_timeout bounds it anyway, so a wait that ever did hang fails
 * this test in seconds instead of holding the tables until the worker exits.
 */
async function lockEverything() {
  const deadline = Date.now() + 20_000;
  for (;;) {
    await client.query("BEGIN");
    try {
      const { ok } = await one<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [AUDIT_CHAIN_LOCK]);
      if (ok) {
        await client.query(`LOCK TABLE projects, workflow_statuses, work_items IN ACCESS EXCLUSIVE MODE NOWAIT`);
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        return;
      }
    } catch (e) {
      if ((e as { code?: string }).code !== "55P03") throw e; // lock_not_available
    }
    await client.query("ROLLBACK");
    if (Date.now() > deadline) throw new Error("could not take the work_items / projects / audit-chain locks in 20s");
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
  }
}

async function dropFks() {
  await client.query(`ALTER TABLE work_items DROP CONSTRAINT work_items_project_id_fkey`);
  await client.query(`ALTER TABLE work_items DROP CONSTRAINT work_items_project_id_column_key_fkey`);
}

/** The constraints as a database that had orphans when 20261023230000 ran holds them. */
async function addFksNotValid() {
  await client.query(`ALTER TABLE work_items ADD CONSTRAINT work_items_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`);
  await client.query(`ALTER TABLE work_items ADD CONSTRAINT work_items_project_id_column_key_fkey
    FOREIGN KEY (project_id, column_key) REFERENCES workflow_statuses(project_id, key)
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID`);
}

async function validated(): Promise<Record<string, boolean>> {
  const r = await client.query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1)`,
    [FKS],
  );
  return Object.fromEntries(r.rows.map((x) => [x.conname, x.convalidated]));
}

const NOT_VALID = { work_items_project_id_fkey: false, work_items_project_id_column_key_fkey: false };
const VALID = { work_items_project_id_fkey: true, work_items_project_id_column_key_fkey: true };

const orphanCount = () =>
  countOf(`work_items w WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = w.project_id)`);

const purgeAudits = async (orgId: string) =>
  (
    await client.query<{ metadata: { items: string; projects: string; itemIds: string[]; projectIds: string[] } }>(
      `SELECT metadata FROM audit_logs WHERE action = 'work_item.purge_orphans' AND org_id = $1`,
      [orgId],
    )
  ).rows;

/** test-org, alice, and a type an item there may use -- the org's own, or the global built-in. */
async function seeded() {
  return one<{ orgId: string; userId: string; typeId: string }>(
    `SELECT o.id AS "orgId",
            (SELECT u.id FROM users u JOIN org_members m ON m.user_id = u.id AND m.org_id = o.id
              WHERE u.email = 'alice@test.local' ORDER BY u.created_at LIMIT 1) AS "userId",
            (SELECT t.id FROM work_item_types t WHERE t.org_id = o.id OR t.org_id IS NULL
              ORDER BY (t.org_id IS NULL), t.id LIMIT 1) AS "typeId"
     FROM organizations o WHERE o.slug = 'test-org'`,
  );
}

const stamp = () => Math.random().toString(36).slice(2, 8).toUpperCase();

/** A project with a 'todo' status, as every project has. */
async function makeProject(orgId: string, opts: { archived?: boolean } = {}) {
  const s = stamp();
  const { id } = await one<{ id: string }>(
    `INSERT INTO projects (org_id, name, key, archived, updated_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [orgId, `Purge test ${s}`, `PT${s}`, opts.archived ?? false],
  );
  await client.query(
    `INSERT INTO workflow_statuses (org_id, project_id, key, name, category) VALUES ($1, $2, 'todo', 'To do', 'TODO')`,
    [orgId, id],
  );
  return id;
}

let ticket = 0;
async function makeItem(s: { orgId: string; userId: string; typeId: string }, projectId: string, columnKey = "todo") {
  const { id } = await one<{ id: string }>(
    `INSERT INTO work_items (org_id, project_id, title, column_key, ticket_number, created_by_id, updated_at, work_item_type_id)
     VALUES ($1, $2, 'purge test', $3, $4, $5, now(), $6) RETURNING id`,
    [s.orgId, projectId, columnKey, ++ticket, s.userId, s.typeId],
  );
  return id;
}

beforeEach(async () => {
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await lockEverything();
});

afterEach(async () => {
  await client.query("ROLLBACK");
  await client.end();
});

describe("purge_orphan_work_items", () => {
  it("is one statement, so `prisma migrate deploy` cannot commit part of it", () => {
    // migrate deploy splits a file into statements and sends each outside a
    // transaction (see 20261024070000_cql_indexes). Several statements here
    // would mean a failed VALIDATE leaves the delete -- and the audit row
    // claiming it -- committed. One DO block applies whole or not at all.
    const code = MIGRATION_SQL.replace(/--[^\n]*/g, "").trim();
    expect(code.startsWith("DO $$")).toBe(true);
    expect(code.endsWith("END $$;")).toBe(true);
    expect(code.split("$$")).toHaveLength(3);
  });

  it("removes an item whose project is gone, with its own rows, and nothing else", async () => {
    const s = await seeded();
    expect(s.userId, "test-org's alice is seeded").toBeTruthy();
    expect(s.typeId, "a work-item type test-org can use is seeded").toBeTruthy();
    expect(await orphanCount(), "the database starts with no orphans of its own").toBe(0);

    // Controls: an item in a live project, and one in an ARCHIVED project --
    // archived is not deleted, and must not be read as such.
    const liveProject = await makeProject(s.orgId);
    const live = await makeItem(s, liveProject);
    const archivedProject = await makeProject(s.orgId, { archived: true });
    const archived = await makeItem(s, archivedProject);

    // The orphan: an item with an activity and a comment of its own, whose
    // project is deleted while the foreign keys are off -- how prod got them.
    const goneProject = await makeProject(s.orgId);
    const orphan = await makeItem(s, goneProject);
    await client.query(`INSERT INTO activities (org_id, user_id, action, work_item_id) VALUES ($1, $2, 'created', $3)`, [
      s.orgId,
      s.userId,
      orphan,
    ]);
    await client.query(
      `INSERT INTO comments (org_id, author_id, content, updated_at, work_item_id) VALUES ($1, $2, 'note', now(), $3)`,
      [s.orgId, s.userId, orphan],
    );
    await dropFks();
    await client.query(`DELETE FROM projects WHERE id = $1`, [goneProject]);
    await addFksNotValid();

    // The starting state is the one on a long-lived database, or nothing below
    // proves anything.
    expect(await validated()).toEqual(NOT_VALID);
    expect(await orphanCount()).toBe(1);
    const before = await countOf(`work_items`);

    await client.query(MIGRATION_SQL);

    // Exactly one row went -- the whole table is counted, not just the
    // controls, and no other transaction can write to it while this one holds it.
    expect(await countOf(`work_items`)).toBe(before - 1);
    expect(await countOf(`work_items WHERE id = $1`, [orphan])).toBe(0);
    expect(await countOf(`activities WHERE work_item_id = $1`, [orphan])).toBe(0);
    expect(await countOf(`comments WHERE work_item_id = $1`, [orphan])).toBe(0);
    expect(await countOf(`work_items WHERE id = $1`, [live])).toBe(1);
    expect(await countOf(`work_items WHERE id = $1`, [archived])).toBe(1);
    expect(await validated()).toEqual(VALID);

    // What went is on record, by id.
    const audits = await purgeAudits(s.orgId);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata.items).toBe("1");
    expect(audits[0].metadata.itemIds).toEqual([orphan]);
    expect(audits[0].metadata.projectIds).toEqual([goneProject]);
  });

  it("gives a live item whose status is missing an archived one, so the second key validates", async () => {
    // An item written between 20261023230000's backfill and its index, or
    // imported with triggers off, can hold a key no status has. Without the
    // backfill the second VALIDATE fails -- and before this was one statement,
    // it failed AFTER the delete had committed.
    const s = await seeded();
    const project = await makeProject(s.orgId);
    await dropFks();
    // Every branch of 20261023230000's rule, and its order: "cancel" is tested
    // before "done", so a key with both is CANCELLED. Two items share one key,
    // which must yield one status, not two.
    const items = [
      await makeItem(s, project, "qa-closed"),
      await makeItem(s, project, "done-then-cancelled"),
      await makeItem(s, project, "legacy-triage"),
      await makeItem(s, project, "legacy-triage"),
    ];
    await addFksNotValid();
    const missing = `workflow_statuses WHERE project_id = $1 AND key IN ('qa-closed', 'done-then-cancelled', 'legacy-triage')`;
    expect(await countOf(missing, [project])).toBe(0);
    expect(await validated()).toEqual(NOT_VALID);

    await client.query(MIGRATION_SQL);

    const statuses = await client.query<{ key: string; category: string; archived: boolean }>(
      `SELECT key, category::text, archived_at IS NOT NULL AS archived FROM ${missing} ORDER BY key`,
      [project],
    );
    // Archived, category from the key's spelling only.
    expect(statuses.rows).toEqual([
      { key: "done-then-cancelled", category: "CANCELLED", archived: true },
      { key: "legacy-triage", category: "TODO", archived: true },
      { key: "qa-closed", category: "DONE", archived: true },
    ]);
    expect(await countOf(`work_items WHERE id = ANY($1::uuid[])`, [items])).toBe(4);
    expect(await validated()).toEqual(VALID);
  });

  it("on a database with no orphans, deletes nothing, records nothing, and still validates", async () => {
    expect(await orphanCount(), "the database starts with no orphans of its own").toBe(0);
    await dropFks();
    await addFksNotValid();
    const before = await countOf(`work_items`);
    const auditsBefore = await countOf(`audit_logs WHERE action = 'work_item.purge_orphans'`);

    await client.query(MIGRATION_SQL);

    expect(await countOf(`work_items`)).toBe(before);
    expect(await countOf(`audit_logs WHERE action = 'work_item.purge_orphans'`)).toBe(auditsBefore);
    expect(await validated()).toEqual(VALID);
  });
});
