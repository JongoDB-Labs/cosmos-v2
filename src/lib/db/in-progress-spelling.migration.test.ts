// @vitest-environment node
//
// Effect of the 20261110233000_in_progress_status_spelling migration, proven by
// applying the real migration.sql to the real e2e database inside a transaction
// that is rolled back, leaving the shared database as it found it.
//
// Every case builds its rows in an organisation of its own. The migration skips
// a whole org when anything there names `in_progress`, so a case in the shared
// test-org would depend on what other test files happened to commit there.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const MIGRATION_SQL = readFileSync(
  path.join(process.cwd(), "prisma/migrations/20261110233000_in_progress_status_spelling/migration.sql"),
  "utf8",
);

/** audit_logs_hash_chain()'s lock (20260606070000_audit_hash_chain). */
const AUDIT_CHAIN_LOCK = 491000001;
const ACTION = "workflow_status.normalize_in_progress";

let client: pg.Client;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await client.query(sql, params)).rows[0] as T;
}

const countOf = async (sql: string, params: unknown[] = []) =>
  (await one<{ c: number }>(`SELECT count(*)::int AS c FROM ${sql}`, params)).c;

/**
 * The migration rewrites matching rows in every org, including rows other test
 * files committed, so it needs the tables it writes to itself. Taken up front
 * and never waited for (try-lock, NOWAIT), as in purge-orphan-work-items' test:
 * locks taken one at a time against a file holding them in the other order can
 * deadlock, and Postgres may fail the other file's transaction.
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
    if (Date.now() > deadline) throw new Error("could not take the status / item / audit-chain locks in 20s");
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
  }
}

const stamp = () => Math.random().toString(36).slice(2, 8).toUpperCase();

interface Org {
  orgId: string;
  userId: string;
  typeId: string;
}

/** An organisation of the case's own, with a work-item type; alice creates its items. */
async function makeOrg(): Promise<Org> {
  const s = stamp();
  const { id: orgId } = await one<{ id: string }>(
    `INSERT INTO organizations (name, slug, updated_at) VALUES ($1, $2, now()) RETURNING id`,
    [`Spelling ${s}`, `spelling-${s.toLowerCase()}`],
  );
  const { id: userId } = await one<{ id: string }>(
    `SELECT id FROM users WHERE email = 'alice@test.local' ORDER BY created_at LIMIT 1`,
  );
  const { id: typeId } = await one<{ id: string }>(
    `INSERT INTO work_item_types (org_id, key, name) VALUES ($1, 'task', 'Task') RETURNING id`,
    [orgId],
  );
  return { orgId, userId, typeId };
}

interface StatusSpec {
  key: string;
  category: "TODO" | "IN_PROGRESS";
  archived?: boolean;
}

/** A project with a 'todo' status plus the given ones. */
async function makeProject(o: Org, statuses: StatusSpec[]) {
  const s = stamp();
  const { id } = await one<{ id: string }>(
    `INSERT INTO projects (org_id, name, key, updated_at) VALUES ($1, $2, $3, now()) RETURNING id`,
    [o.orgId, `Spelling test ${s}`, `ST${s}`],
  );
  for (const st of [{ key: "todo", category: "TODO" as const }, ...statuses]) {
    await client.query(
      `INSERT INTO workflow_statuses (org_id, project_id, key, name, category, archived_at)
       VALUES ($1, $2, $3, $3, $4::"ColumnCategory", CASE WHEN $5 THEN now() END)`,
      [o.orgId, id, st.key, st.category, st.archived ?? false],
    );
  }
  return id;
}

/** The backfill artifact: an archived `in_progress` beside the live `in-progress`. */
const ARTIFACT: StatusSpec[] = [
  { key: "in-progress", category: "IN_PROGRESS" },
  { key: "in_progress", category: "TODO", archived: true },
];

let ticket = 0;
async function makeItem(o: Org, projectId: string, columnKey: string) {
  const { id } = await one<{ id: string }>(
    `INSERT INTO work_items (org_id, project_id, title, column_key, ticket_number, created_by_id, updated_at, work_item_type_id)
     VALUES ($1, $2, 'spelling test', $3, $4, $5, now(), $6) RETURNING id`,
    [o.orgId, projectId, columnKey, ++ticket, o.userId, o.typeId],
  );
  return id;
}

/** Everything about a project's statuses and items a migration could change. */
async function snapshot(projectId: string) {
  const statuses = await client.query(
    `SELECT id, key, name, category::text, sort_order, archived_at IS NOT NULL AS archived
     FROM workflow_statuses WHERE project_id = $1 ORDER BY key`,
    [projectId],
  );
  const items = await client.query(`SELECT id, column_key FROM work_items WHERE project_id = $1 ORDER BY id`, [projectId]);
  return { statuses: statuses.rows, items: items.rows };
}

const keysOf = async (itemIds: string[]) =>
  (
    await client.query<{ column_key: string }>(`SELECT column_key FROM work_items WHERE id = ANY($1::uuid[])`, [itemIds])
  ).rows.map((r) => r.column_key);

const audits = async (orgId: string) =>
  (
    await client.query<{ metadata: { merged: string; items: string; projectIds: string[]; itemIds: string[] } }>(
      `SELECT metadata FROM audit_logs WHERE action = $1 AND org_id = $2`,
      [ACTION, orgId],
    )
  ).rows;

/** Something in the org, other than a status or an item, that names a key. */
const NAMERS: Record<string, (o: Org, projectId: string, key: string) => Promise<unknown>> = {
  "a board column's key": async (o, projectId, key) => {
    const { id } = await one<{ id: string }>(
      `INSERT INTO boards (org_id, project_id, name, type) VALUES ($1, $2, 'Board', 'KANBAN') RETURNING id`,
      [o.orgId, projectId],
    );
    await client.query(`INSERT INTO board_columns (board_id, name, key) VALUES ($1, 'Doing', $2)`, [id, key]);
  },
  "a board column's status list": async (o, projectId, key) => {
    const { id } = await one<{ id: string }>(
      `INSERT INTO boards (org_id, project_id, name, type) VALUES ($1, $2, 'Board', 'KANBAN') RETURNING id`,
      [o.orgId, projectId],
    );
    await client.query(`INSERT INTO board_columns (board_id, name, key, status_keys) VALUES ($1, 'Doing', 'doing', $2)`, [
      id,
      [key],
    ]);
  },
  "a board's config": (o, projectId, key) =>
    client.query(`INSERT INTO boards (org_id, project_id, name, type, config) VALUES ($1, $2, 'Board', 'TABLE', $3)`, [
      o.orgId,
      projectId,
      { cql: `status = ${key}` },
    ]),
  "an automation rule": (o, _projectId, key) =>
    client.query(
      `INSERT INTO automation_rules (org_id, name, spec, actor_cap, updated_at) VALUES ($1, 'Rule', $2, 'MEMBER', now())`,
      [o.orgId, { trigger: { type: "status_changed", to: key } }],
    ),
  "a saved view's CQL": (o, _projectId, key) =>
    client.query(
      `INSERT INTO saved_views (org_id, owner_id, name, cql_text, updated_at) VALUES ($1, $2, $3, $4, now())`,
      [o.orgId, o.userId, `View ${stamp()}`, `status in (todo, ${key})`], // unique per owner and name
    ),
  "a workflow version": async (o, _projectId, key) => {
    const { id } = await one<{ id: string }>(
      `INSERT INTO workflows (org_id, name, created_by_id, updated_at) VALUES ($1, 'Flow', $2, now()) RETURNING id`,
      [o.orgId, o.userId],
    );
    await client.query(
      `INSERT INTO workflow_versions (org_id, workflow_id, version, definition, checksum) VALUES ($1, $2, 1, $3, 'x')`,
      [o.orgId, id, { statuses: [{ key }] }],
    );
  },
  "a saved view's filter, from before CQL": (o, _projectId, key) =>
    client.query(`INSERT INTO saved_views (org_id, owner_id, name, filter, updated_at) VALUES ($1, $2, $3, $4, now())`, [
      o.orgId,
      o.userId,
      `View ${stamp()}`,
      { status: ["todo", key] },
    ]),
  "a saved view's query": (o, _projectId, key) =>
    client.query(`INSERT INTO saved_views (org_id, owner_id, name, query, updated_at) VALUES ($1, $2, $3, $4, now())`, [
      o.orgId,
      o.userId,
      `View ${stamp()}`,
      { field: "status", op: "in", values: [key] },
    ]),
  "a workflow version's migration map": async (o, _projectId, key) => {
    const { id } = await one<{ id: string }>(
      `INSERT INTO workflows (org_id, name, created_by_id, updated_at) VALUES ($1, 'Flow', $2, now()) RETURNING id`,
      [o.orgId, o.userId],
    );
    await client.query(
      `INSERT INTO workflow_versions (org_id, workflow_id, version, definition, migration_map, checksum) VALUES ($1, $2, 1, $3, $4, 'x')`,
      [o.orgId, id, { statuses: [{ key: "todo" }] }, { [key]: "todo" }],
    );
  },
  "a workflow assignment's migration map": async (o, projectId, key) => {
    const { id } = await one<{ id: string }>(
      `INSERT INTO workflows (org_id, name, created_by_id, updated_at) VALUES ($1, 'Flow', $2, now()) RETURNING id`,
      [o.orgId, o.userId],
    );
    await client.query(
      `INSERT INTO workflow_assignments (org_id, project_id, workflow_id, migration_map) VALUES ($1, $2, $3, $4)`,
      [o.orgId, projectId, id, { [key]: "todo" }],
    );
  },
};

beforeEach(async () => {
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await lockEverything();
});

afterEach(async () => {
  await client.query("ROLLBACK");
  await client.end();
});

describe("in_progress_status_spelling", () => {
  it("is one statement, so `prisma migrate deploy` cannot commit part of it", () => {
    // migrate deploy sends each statement of a file on its own, outside a
    // transaction (see 20261110200000_purge_orphan_work_items). One DO block
    // applies whole or not at all.
    const code = MIGRATION_SQL.replace(/--[^\n]*/g, "").trim();
    expect(code.startsWith("DO $$")).toBe(true);
    expect(code.endsWith("END $$;")).toBe(true);
    expect(code.split("$$")).toHaveLength(3);
  });

  it("merges an archived `in_progress` into the project's live `in-progress`, and leaves that status as it was", async () => {
    const o = await makeOrg();
    const project = await makeProject(o, ARTIFACT);
    const stranded = [await makeItem(o, project, "in_progress"), await makeItem(o, project, "in_progress")];
    const already = await makeItem(o, project, "in-progress");
    const elsewhere = await makeItem(o, project, "todo"); // the control: an item under another status
    // A near-miss key is a different status, and stays one.
    const nearMiss = await makeProject(o, [{ key: "in_progress_qa", category: "IN_PROGRESS" }]);
    await makeItem(o, nearMiss, "in_progress_qa");
    const before = await snapshot(project);
    const nearMissBefore = await snapshot(nearMiss);
    const live = before.statuses.find((s) => s.key === "in-progress");

    await client.query(MIGRATION_SQL);

    const after = await snapshot(project);
    // The live row is the very same row, unchanged; the archived one is gone.
    expect(after.statuses).toEqual(before.statuses.filter((s) => s.key !== "in_progress"));
    expect(after.statuses.find((s) => s.key === "in-progress")).toEqual(live);
    expect(await keysOf([...stranded, already])).toEqual(["in-progress", "in-progress", "in-progress"]);
    expect(await keysOf([elsewhere])).toEqual(["todo"]);
    expect(await snapshot(nearMiss)).toEqual(nearMissBefore);

    // What moved is on record, by id.
    const rows = await audits(o.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ merged: "1", items: "2", projectIds: [project] });
    expect([...rows[0].metadata.itemIds].sort()).toEqual([...stranded].sort());
  });

  it("holds the statuses it decides on until it commits, so none is restored or archived between its decision and its delete", async () => {
    // A row this transaction locked carries its id in xmax. The live
    // `in-progress` is only read, so without the lock it is never marked: a
    // concurrent archive could leave the items it receives on an archived status.
    // No items here: moving one would key-share lock the row through its foreign
    // key, which marks xmax too but blocks no archive, and would pass this alone.
    const o = await makeOrg();
    const project = await makeProject(o, ARTIFACT);
    await client.query(MIGRATION_SQL);
    expect(await countOf(`workflow_statuses WHERE project_id = $1 AND key = 'in_progress'`, [project])).toBe(0); // it did merge
    const { locked } = await one<{ locked: boolean }>(
      `SELECT xmax::text = (pg_current_xact_id()::text::bigint % 4294967296)::text AS locked
         FROM workflow_statuses WHERE project_id = $1 AND key = 'in-progress'`,
      [project],
    );
    expect(locked).toBe(true);
  });

  it("never touches a LIVE `in_progress`, whatever is beside it, nor merges into an archived `in-progress`", async () => {
    const o = await makeOrg();
    // A live one is a status a board can show through its column key, so
    // renaming or merging it would empty that column.
    const left = [
      await makeProject(o, [{ key: "in_progress", category: "IN_PROGRESS" }]), // the old spelling only
      await makeProject(o, [
        { key: "in_progress", category: "IN_PROGRESS" },
        { key: "in-progress", category: "IN_PROGRESS", archived: true }, // the new one is the archived one
      ]),
      await makeProject(o, [
        { key: "in_progress", category: "IN_PROGRESS" },
        { key: "in-progress", category: "IN_PROGRESS" }, // both live
      ]),
      // Both archived: merging would only move the items into another hidden status.
      await makeProject(o, [
        { key: "in_progress", category: "TODO", archived: true },
        { key: "in-progress", category: "IN_PROGRESS", archived: true },
      ]),
    ];
    for (const p of left) await makeItem(o, p, "in_progress");
    // In the same org, an artifact the migration does merge: proof it ran here.
    const merged = await makeProject(o, ARTIFACT);
    await makeItem(o, merged, "in_progress");
    const before = await Promise.all(left.map(snapshot));

    await client.query(MIGRATION_SQL);

    expect(await Promise.all(left.map(snapshot))).toEqual(before);
    expect((await audits(o.orgId)).map((r) => r.metadata.projectIds)).toEqual([[merged]]);
  });

  for (const [what, name] of Object.entries(NAMERS)) {
    it(`skips the whole org when ${what} names \`in_progress\``, async () => {
      const named = await makeOrg();
      const project = await makeProject(named, ARTIFACT);
      await makeItem(named, project, "in_progress");
      await name(named, project, "in_progress");
      // Positive control: the same artifact in an org where nothing names the
      // key, and one where only a near-miss key is named, are merged.
      const clean = await makeOrg();
      const cleanProject = await makeProject(clean, ARTIFACT);
      await makeItem(clean, cleanProject, "in_progress");
      const nearMiss = await makeOrg();
      const nearMissProject = await makeProject(nearMiss, ARTIFACT);
      await makeItem(nearMiss, nearMissProject, "in_progress");
      await name(nearMiss, nearMissProject, "in_progress_qa");
      const before = await snapshot(project);

      await client.query(MIGRATION_SQL);

      expect(await snapshot(project)).toEqual(before);
      expect(await audits(named.orgId)).toEqual([]);
      expect(await audits(clean.orgId)).toHaveLength(1);
      expect(await audits(nearMiss.orgId)).toHaveLength(1);
    });
  }

  it("a second run changes nothing and records nothing", async () => {
    const o = await makeOrg();
    const project = await makeProject(o, ARTIFACT);
    await makeItem(o, project, "in_progress");
    await client.query(MIGRATION_SQL);
    expect(await audits(o.orgId), "the first run did merge").toHaveLength(1);
    // Its temp tables are ON COMMIT DROP, and this transaction never commits.
    await client.query(`DROP TABLE spelling_named, spelling_statuses, spelling_items`);
    const state = async () => ({
      statuses: await countOf(`workflow_statuses`),
      oldKey: await countOf(`workflow_statuses WHERE key = 'in_progress'`),
      items: await countOf(`work_items WHERE column_key = 'in-progress'`),
      audits: await countOf(`audit_logs WHERE action = $1`, [ACTION]),
    });
    const before = await state();

    await client.query(MIGRATION_SQL);

    expect(await state()).toEqual(before);
  });
});
