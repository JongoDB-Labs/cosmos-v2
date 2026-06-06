// scripts/cutover/lib/upsert.test.ts
//
// Two layers:
//   1. PURE tests of the UPSERT SQL builders + the DataClassification dedupe-with-audit.
//   2. INTEGRATION tests against a real PG16 — proving the generated UPSERTs actually replay
//      idempotently (DO NOTHING for append-only; DO UPDATE only when updated_at advances).
//      The integration block self-skips when no Postgres is reachable (so the suite is green
//      in CI without a DB); point it at one with CUTOVER_TEST_PG_URL.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildUpsert, dedupeClassifications, type ClassificationRow } from "./upsert";
import { rankOf, type ModelPlan } from "./model-graph";

// ── Fixtures: hand-built ModelPlans (the real shapes the graph derives) ──

const appendOnlyPlan: ModelPlan = {
  model: "ChatMessage",
  table: "chat_messages",
  pk: ["id"],
  appendOnly: true,
  updatedAtColumn: null,
  moneyColumns: [],
  scope: { kind: "PARENT" },
};

const mutablePlan: ModelPlan = {
  model: "WorkItem",
  table: "work_items",
  pk: ["id"],
  appendOnly: false,
  updatedAtColumn: "updated_at",
  moneyColumns: [],
  scope: { kind: "DIRECT", orgIdColumn: "org_id" },
};

const compositePlan: ModelPlan = {
  model: "OrgMemberWorkRole",
  table: "org_member_work_roles",
  pk: ["org_member_id", "work_role_id"],
  appendOnly: true,
  updatedAtColumn: null,
  moneyColumns: [],
  scope: { kind: "PARENT" },
};

describe("buildUpsert — SQL shape", () => {
  it("append-only ⇒ ON CONFLICT (id) DO NOTHING", () => {
    const s = buildUpsert(appendOnlyPlan, ["id", "content"], ["x", "hi"]);
    expect(s.sql).toContain('INSERT INTO "chat_messages" ("id", "content")');
    expect(s.sql).toContain("ON CONFLICT (\"id\") DO NOTHING");
    expect(s.sql).toContain("RETURNING (xmax = 0) AS __inserted");
    expect(s.params).toEqual(["x", "hi"]);
  });

  it("mutable ⇒ DO UPDATE on non-PK cols, gated by updated_at strictly newer", () => {
    const s = buildUpsert(mutablePlan, ["id", "org_id", "title", "updated_at"], ["1", "o", "T", "2026"]);
    expect(s.sql).toContain("ON CONFLICT (\"id\") DO UPDATE SET");
    expect(s.sql).toContain('"org_id" = EXCLUDED."org_id"');
    expect(s.sql).toContain('"title" = EXCLUDED."title"');
    expect(s.sql).toContain('"updated_at" = EXCLUDED."updated_at"');
    // PK is never in the SET list
    expect(s.sql).not.toMatch(/SET[^]*"id" = EXCLUDED."id"/);
    expect(s.sql).toContain('WHERE EXCLUDED."updated_at" > "work_items"."updated_at"');
  });

  it("composite PK ⇒ ON CONFLICT (org_member_id, work_role_id)", () => {
    const s = buildUpsert(compositePlan, ["org_member_id", "work_role_id", "scope"], ["m", "r", null]);
    expect(s.sql).toContain('ON CONFLICT ("org_member_id", "work_role_id") DO NOTHING');
  });

  it("rejects column/value arity mismatch", () => {
    expect(() => buildUpsert(appendOnlyPlan, ["id", "content"], ["x"])).toThrow(/arity/);
  });

  it("rejects a plan whose PK column isn't in the column list", () => {
    expect(() => buildUpsert(appendOnlyPlan, ["content"], ["hi"])).toThrow(/PK column/);
  });
});

describe("dedupeClassifications — fail-closed, markings verbatim", () => {
  const base = (over: Partial<ClassificationRow>): ClassificationRow => ({
    id: "00000000-0000-0000-0000-000000000000",
    org_id: "ORG1",
    project_id: null,
    level: "UNCLASSIFIED",
    markings: [],
    handling_instructions: "",
    ...over,
  });

  it("keeps the HIGHEST-rank ceiling and logs the drop", () => {
    const rows = [
      base({ id: "aaaa0000-0000-0000-0000-000000000001", level: "FOUO", markings: ["FOUO"] }),
      base({ id: "bbbb0000-0000-0000-0000-000000000002", level: "CUI", markings: ["CUI//SP-PRVCY"], handling_instructions: "destroy by shredding" }),
    ];
    const { kept, drops } = dedupeClassifications(rows, rankOf);
    expect(kept.length).toBe(1);
    expect(kept[0].level).toBe("CUI");
    // survivor markings + handling are carried VERBATIM
    expect(kept[0].markings).toEqual(["CUI//SP-PRVCY"]);
    expect(kept[0].handling_instructions).toBe("destroy by shredding");
    expect(drops.length).toBe(1);
    expect(drops[0].droppedLevel).toBe("FOUO");
    expect(drops[0].keptLevel).toBe("CUI");
    expect(drops[0].droppedMarkings).toEqual(["FOUO"]);
  });

  it("passes project-scoped rows straight through (already unique per org,project)", () => {
    const rows = [
      base({ id: "p1", project_id: "PROJ1", level: "CUI" }),
      base({ id: "p2", project_id: "PROJ2", level: "FOUO" }),
    ];
    const { kept, drops } = dedupeClassifications(rows, rankOf);
    expect(kept.length).toBe(2);
    expect(drops.length).toBe(0);
  });

  it("dedupes per-org independently", () => {
    const rows = [
      base({ id: "o1a", org_id: "ORG1", level: "FOUO" }),
      base({ id: "o1b", org_id: "ORG1", level: "CUI" }),
      base({ id: "o2a", org_id: "ORG2", level: "PUBLIC" }),
    ];
    const { kept, drops } = dedupeClassifications(rows, rankOf);
    expect(kept.length).toBe(2); // one per org
    expect(kept.find((r) => r.org_id === "ORG1")?.level).toBe("CUI");
    expect(kept.find((r) => r.org_id === "ORG2")?.level).toBe("PUBLIC");
    expect(drops.length).toBe(1);
  });

  it("tie on rank ⇒ deterministic (smallest id wins), stable across re-runs", () => {
    const rows = [
      base({ id: "zzzz0000-0000-0000-0000-000000000002", level: "CUI" }),
      base({ id: "aaaa0000-0000-0000-0000-000000000001", level: "CUI" }),
    ];
    const a = dedupeClassifications(rows, rankOf);
    const b = dedupeClassifications([...rows].reverse(), rankOf);
    expect(a.kept[0].id).toBe("aaaa0000-0000-0000-0000-000000000001");
    expect(b.kept[0].id).toBe("aaaa0000-0000-0000-0000-000000000001");
  });
});

// ── Integration: real PG16 round-trip (self-skips without a reachable DB) ──

const PG_URL = process.env.CUTOVER_TEST_PG_URL ?? "postgresql://u:p@localhost:55999/d";

async function canConnect(url: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await canConnect(PG_URL);
const maybe = pgAvailable ? describe : describe.skip;

maybe("buildUpsert — idempotent replay against real PG16", () => {
  let client: pg.Client;
  const SCHEMA = "cutover_upsert_test";

  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(`CREATE TABLE chat_messages (id uuid primary key, content text)`);
    await client.query(
      `CREATE TABLE work_items (id uuid primary key, org_id uuid, title text, updated_at timestamptz)`,
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await client.end();
    }
  });

  it("append-only: insert once, re-run is a no-op (skipped)", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const s = buildUpsert(appendOnlyPlan, ["id", "content"], [id, "hello"]);
    const r1 = await client.query(s.sql, s.params);
    expect(r1.rowCount).toBe(1);
    expect(r1.rows[0].__inserted).toBe(true);
    // re-run: DO NOTHING ⇒ no returned row
    const r2 = await client.query(s.sql, s.params);
    expect(r2.rowCount).toBe(0);
    // a different content with the SAME id must NOT overwrite (append-only)
    const s2 = buildUpsert(appendOnlyPlan, ["id", "content"], [id, "TAMPERED"]);
    await client.query(s2.sql, s2.params);
    const got = await client.query("SELECT content FROM chat_messages WHERE id = $1", [id]);
    expect(got.rows[0].content).toBe("hello");
  });

  it("mutable: updates only when updated_at is strictly newer (last-writer-wins)", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const org = "33333333-3333-3333-3333-333333333333";
    const cols = ["id", "org_id", "title", "updated_at"];
    const t1 = new Date("2026-06-06T10:00:00Z");
    const t2 = new Date("2026-06-06T11:00:00Z");

    const ins = buildUpsert(mutablePlan, cols, [id, org, "v1", t1]);
    const r1 = await client.query(ins.sql, ins.params);
    expect(r1.rows[0].__inserted).toBe(true);

    // same updated_at ⇒ WHERE false ⇒ skipped (idempotent re-run)
    const same = buildUpsert(mutablePlan, cols, [id, org, "v1-again", t1]);
    const rSame = await client.query(same.sql, same.params);
    expect(rSame.rowCount).toBe(0);
    expect((await client.query("SELECT title FROM work_items WHERE id=$1", [id])).rows[0].title).toBe("v1");

    // newer updated_at ⇒ updates
    const newer = buildUpsert(mutablePlan, cols, [id, org, "v2", t2]);
    const rNew = await client.query(newer.sql, newer.params);
    expect(rNew.rowCount).toBe(1);
    expect(rNew.rows[0].__inserted).toBe(false); // it was an UPDATE
    expect((await client.query("SELECT title FROM work_items WHERE id=$1", [id])).rows[0].title).toBe("v2");

    // OLDER updated_at ⇒ does NOT clobber the newer row
    const older = buildUpsert(mutablePlan, cols, [id, org, "stale", t1]);
    const rOld = await client.query(older.sql, older.params);
    expect(rOld.rowCount).toBe(0);
    expect((await client.query("SELECT title FROM work_items WHERE id=$1", [id])).rows[0].title).toBe("v2");
  });
});
