// scripts/cutover/lib/model-graph.test.ts
//
// Unit tests for the schema-driven migration plan. These run against the REAL DMMF
// (pure, no DB) so they assert the actual derived classification of known models —
// append-only vs mutable, money columns, and org-scope paths (DIRECT / PARENT / ROOT
// / MEMBER) — exactly as the export/import/verify steps will consume them.
//
// resolveColumns() (which needs a live information_schema) is exercised against a tiny
// fake pg client so the column-stripping logic (generated / search_vector / db-only) is
// covered without a database.

import { describe, it, expect } from "vitest";
import {
  buildModelPlans,
  modelPlanByName,
  buildScopedSelect,
  resolveColumns,
  rankOf,
  V2_ONLY_MODELS,
  EXCLUDED_GLOBAL_MODELS,
  fkEdgesOf,
  closureTargetTables,
  discoverOrphanProbeTargets,
  orphanProbeSql,
  migratedTableSet,
  BARE_USER_REF_COLUMNS,
  type ModelPlan,
} from "./model-graph";

const plans = buildModelPlans();
const byName = modelPlanByName();

function plan(name: string): ModelPlan {
  const p = byName.get(name);
  if (!p) throw new Error(`expected ${name} to be a migratable model`);
  return p;
}

describe("buildModelPlans — classification", () => {
  it("derives a non-trivial set of org-scoped models (the shared business graph)", () => {
    // The shared ~84 org-scoped models minus the excluded globals; not hardcoded but
    // sanity-bounded so a derivation regression (e.g. dropping all PARENT models) fails.
    // Bumped from <75 when the prod-parity reconciliation added 17 org-scoped models
    // (chat_bots, work_item_links, finance/bank/document tables — migration
    // 20260607030000); ChatAlertKeyword is user-scoped so it's not a plan here.
    // Bumped from <95 when the PM Dashboard added 4 org-scoped govcon models
    // (risks, deliverables, blockers, change_requests — migration 20260627000000).
    // Bumped from <105 when multi-assign added work_item_assignees (migration
    // 20260706070000) — plans hit exactly 105.
    // Bumped from <110 as later org-scoped additions (incl. foreman_ai_settings,
    // the dedicated Foreman Claude connection — migration 20260713150000; DIRECT
    // via org_id, surrogate `id` PK like org_ai_settings) took the count to 110.
    expect(plans.length).toBeGreaterThan(50);
    expect(plans.length).toBeLessThan(115);
  });

  it("excludes the 5 v2-only models (no v1 source)", () => {
    for (const name of V2_ONLY_MODELS) {
      expect(byName.has(name)).toBe(false);
    }
  });

  it("excludes user-global / ephemeral non-tenant tables", () => {
    for (const name of EXCLUDED_GLOBAL_MODELS) {
      expect(byName.has(name)).toBe(false);
    }
  });

  it("never includes _prisma_migrations (not a DMMF model)", () => {
    expect(plans.some((p) => p.table === "_prisma_migrations")).toBe(false);
  });

  it("ChatMessage: append-only, PARENT-scoped via chat_channels.org_id", () => {
    const p = plan("ChatMessage");
    expect(p.table).toBe("chat_messages");
    expect(p.appendOnly).toBe(true); // no updated_at
    expect(p.updatedAtColumn).toBeNull();
    expect(p.scope.kind).toBe("PARENT");
    expect(p.scope.hops?.[0]).toMatchObject({
      fkColumn: "channel_id",
      parentTable: "chat_channels",
      parentPkColumn: "id",
    });
    expect(p.scope.parentOrgIdColumn).toBe("org_id");
  });

  it("ChatMessageReaction: append-only, multi-hop PARENT (message → channel → org)", () => {
    const p = plan("ChatMessageReaction");
    expect(p.appendOnly).toBe(true);
    expect(p.scope.kind).toBe("PARENT");
    expect(p.scope.hops?.length).toBe(2);
    expect(p.scope.hops?.[0].parentTable).toBe("chat_messages");
    expect(p.scope.hops?.[1].parentTable).toBe("chat_channels");
    expect(p.scope.parentOrgIdColumn).toBe("org_id");
  });

  it("WorkItem: MUTABLE (has updated_at), DIRECT org_id", () => {
    const p = plan("WorkItem");
    expect(p.appendOnly).toBe(false);
    expect(p.updatedAtColumn).toBe("updated_at");
    expect(p.scope.kind).toBe("DIRECT");
    expect(p.scope.orgIdColumn).toBe("org_id");
    expect(p.moneyColumns).toEqual([]); // work items carry no money
  });

  it("JournalLine: append-only, DIRECT org_id, money column `amount`", () => {
    const p = plan("JournalLine");
    expect(p.appendOnly).toBe(true);
    expect(p.updatedAtColumn).toBeNull();
    expect(p.scope.kind).toBe("DIRECT");
    expect(p.moneyColumns).toEqual(["amount"]);
  });

  it("Revenue: a model with a money column (DIRECT, mutable)", () => {
    const p = plan("Revenue");
    expect(p.moneyColumns).toEqual(["amount"]);
    expect(p.scope.kind).toBe("DIRECT");
    expect(p.appendOnly).toBe(false);
  });

  it("MeetingAttendee: a model org-scoped via a PARENT (sync_meetings.org_id)", () => {
    const p = plan("MeetingAttendee");
    expect(p.scope.kind).toBe("PARENT");
    expect(p.scope.hops?.[0]).toMatchObject({
      fkColumn: "meeting_id",
      parentTable: "sync_meetings",
    });
    expect(p.scope.parentOrgIdColumn).toBe("org_id");
  });

  it("Organization: the ROOT, scoped by id", () => {
    const p = plan("Organization");
    expect(p.scope.kind).toBe("ROOT");
    expect(p.table).toBe("organizations");
  });

  it("User: MEMBER-scoped (via org_members)", () => {
    const p = plan("User");
    expect(p.scope.kind).toBe("MEMBER");
    expect(p.table).toBe("users");
  });

  it("orders ROOT then MEMBER first (FK-friendly read order)", () => {
    expect(plans[0].model).toBe("Organization");
    expect(plans[1].model).toBe("User");
  });

  it("most plans have a single `id` PK; the join table has a composite PK", () => {
    const composite = plans.filter((p) => p.pk.length > 1);
    expect(composite.map((p) => p.model)).toEqual(["OrgMemberWorkRole"]);
    expect(composite[0].pk).toEqual(["org_member_id", "work_role_id"]);
    expect(composite[0].appendOnly).toBe(true); // join table has no updated_at
    for (const p of plans) {
      if (p.pk.length === 1) expect(p.pk[0]).toBe("id");
    }
  });
});

describe("buildScopedSelect — org-strict SQL", () => {
  const cols = ["id", "org_id", "title"];

  it("ROOT scopes by id = $1", () => {
    const { sql, params } = buildScopedSelect(plan("Organization"), ["id", "name"], "ORG");
    expect(sql).toContain('WHERE "organizations"."id" = $1');
    expect(params).toEqual(["ORG"]);
  });

  it("MEMBER scopes via org_members subquery", () => {
    const { sql, params } = buildScopedSelect(plan("User"), ["id", "email"], "ORG");
    expect(sql).toContain('"users"."id" IN (SELECT "user_id" FROM "org_members" WHERE "org_id" = $1)');
    expect(params).toEqual(["ORG"]);
  });

  it("DIRECT scopes by the table's own org_id", () => {
    const { sql, params } = buildScopedSelect(plan("WorkItem"), cols, "ORG");
    expect(sql).toContain('WHERE "work_items"."org_id" = $1');
    expect(sql).toContain('ORDER BY "work_items"."id" ASC');
    expect(params).toEqual(["ORG"]);
  });

  it("PARENT joins up the FK chain and scopes the top ancestor's org_id", () => {
    const { sql, params } = buildScopedSelect(plan("ChatMessageReaction"), ["id"], "ORG");
    // two INNER JOINs: reactions → chat_messages → chat_channels
    expect(sql).toContain('INNER JOIN "chat_messages"');
    expect(sql).toContain('INNER JOIN "chat_channels"');
    // org filter is on the TOP ancestor alias, never on the leaf table
    expect(sql).toMatch(/WHERE "__p1"\."org_id" = \$1/);
    expect(params).toEqual(["ORG"]);
  });

  it("never emits a query without an org filter (no unscoped reads)", () => {
    for (const p of plans) {
      const { sql } = buildScopedSelect(p, ["id"], "ORG");
      expect(sql).toMatch(/= \$1|IN \(SELECT/);
    }
  });
});

describe("resolveColumns — strips generated / search_vector / db-only columns", () => {
  // A fake pg client returning a column list for chat_messages incl. the GENERATED
  // content_tsv and a hypothetical db-only column.
  function fakeClient(rows: { column_name: string; is_generated: string }[]) {
    return {
      query: async () => ({ rows }),
    } as unknown as Parameters<typeof resolveColumns>[0];
  }

  it("drops content_tsv (GENERATED ALWAYS) and keeps real scalars", async () => {
    const client = fakeClient([
      { column_name: "id", is_generated: "NEVER" },
      { column_name: "channel_id", is_generated: "NEVER" },
      { column_name: "content", is_generated: "NEVER" },
      { column_name: "content_tsv", is_generated: "ALWAYS" },
      { column_name: "created_at", is_generated: "NEVER" },
    ]);
    const cp = await resolveColumns(client, "ChatMessage");
    expect(cp.columns).toContain("id");
    expect(cp.columns).toContain("content");
    expect(cp.columns).not.toContain("content_tsv");
    expect(cp.stripped.find((s) => s.column === "content_tsv")?.reason).toMatch(/generated/);
  });

  it("drops search_vector and the db-only `embedding` (not a DMMF scalar)", async () => {
    const client = fakeClient([
      { column_name: "id", is_generated: "NEVER" },
      { column_name: "org_id", is_generated: "NEVER" },
      { column_name: "title", is_generated: "NEVER" },
      { column_name: "search_vector", is_generated: "NEVER" },
      { column_name: "embedding", is_generated: "NEVER" },
      { column_name: "updated_at", is_generated: "NEVER" },
    ]);
    const cp = await resolveColumns(client, "WorkItem");
    expect(cp.columns).toContain("title");
    expect(cp.columns).not.toContain("search_vector");
    expect(cp.columns).not.toContain("embedding");
    const reasons = Object.fromEntries(cp.stripped.map((s) => [s.column, s.reason]));
    expect(reasons["search_vector"]).toMatch(/search_vector/);
    expect(reasons["embedding"]).toMatch(/not a DMMF scalar/);
  });

  it("KEEPS enum columns (kind:enum, not scalar — would NULL out on import if dropped)", async () => {
    // Account has enum columns `type` (AccountType) + `normal_balance` (NormalBalance).
    const client = fakeClient([
      { column_name: "id", is_generated: "NEVER" },
      { column_name: "org_id", is_generated: "NEVER" },
      { column_name: "code", is_generated: "NEVER" },
      { column_name: "type", is_generated: "NEVER" },
      { column_name: "normal_balance", is_generated: "NEVER" },
      { column_name: "updated_at", is_generated: "NEVER" },
    ]);
    const cp = await resolveColumns(client, "Account");
    expect(cp.columns).toContain("type");
    expect(cp.columns).toContain("normal_balance");
    expect(cp.stripped.find((s) => s.column === "type")).toBeUndefined();
  });

  it("throws if the PK is somehow absent (defensive invariant)", async () => {
    const client = fakeClient([{ column_name: "org_id", is_generated: "NEVER" }]);
    await expect(resolveColumns(client, "WorkItem")).rejects.toThrow(/PK/);
  });
});

describe("rankOf — classification ordering (fail-closed)", () => {
  it("orders PUBLIC < UNCLASSIFIED < FOUO < CUI < CONFIDENTIAL", () => {
    expect(rankOf("PUBLIC")).toBeLessThan(rankOf("UNCLASSIFIED"));
    expect(rankOf("UNCLASSIFIED")).toBeLessThan(rankOf("FOUO"));
    expect(rankOf("FOUO")).toBeLessThan(rankOf("CUI"));
    expect(rankOf("CUI")).toBeLessThan(rankOf("CONFIDENTIAL"));
  });
});

describe("fkEdgesOf — referential-closure edge derivation (C1 + C2)", () => {
  it("WorkItem: hard FK to WorkItemType (C1 global parent) + bare user refs (C2)", () => {
    const edges = fkEdgesOf("WorkItem");
    const wit = edges.find((e) => e.fkColumn === "work_item_type_id");
    expect(wit).toMatchObject({ targetModel: "WorkItemType", targetTable: "work_item_types", hardFk: true });
    // bare user refs (no DMMF relation) — assignee_id + created_by_id → users
    const assignee = edges.find((e) => e.fkColumn === "assignee_id");
    const creator = edges.find((e) => e.fkColumn === "created_by_id");
    expect(assignee).toMatchObject({ targetTable: "users", hardFk: false });
    expect(creator).toMatchObject({ targetTable: "users", hardFk: false });
  });

  it("HomeWidget: owner_id is a HARD FK to users (relation exists), not a bare ref", () => {
    const edges = fkEdgesOf("HomeWidget");
    const owner = edges.find((e) => e.fkColumn === "owner_id");
    expect(owner).toMatchObject({ targetModel: "User", targetTable: "users", hardFk: true });
    // it must NOT also be listed as a bare ref (would be a duplicate edge)
    expect(edges.filter((e) => e.fkColumn === "owner_id").length).toBe(1);
  });

  it("CycleCapacity: user_id is a HARD FK to users", () => {
    const owner = fkEdgesOf("CycleCapacity").find((e) => e.fkColumn === "user_id");
    expect(owner).toMatchObject({ targetTable: "users", hardFk: true });
  });

  it("DataClassification: applied_by_id is a bare user ref carried by closure", () => {
    const e = fkEdgesOf("DataClassification").find((x) => x.fkColumn === "applied_by_id");
    expect(e).toMatchObject({ targetModel: "User", targetTable: "users", hardFk: false });
  });

  it("the bare-user-ref map only lists columns WITHOUT a DMMF relation", () => {
    // Cross-check: no bare-ref column is ALSO a hard FK on the same table (would duplicate).
    for (const [table, cols] of BARE_USER_REF_COLUMNS) {
      const plan = plans.find((p) => p.table === table);
      if (!plan) continue;
      const hard = new Set(fkEdgesOf(plan.model).filter((e) => e.hardFk).map((e) => e.fkColumn));
      for (const c of cols) {
        expect(hard.has(c), `${table}.${c} should be a BARE ref, not a hard FK`).toBe(false);
      }
    }
  });
});

describe("closureTargetTables — the parent tables closure may fetch", () => {
  it("includes users + the global-parent template tables", () => {
    const targets = closureTargetTables(plans);
    expect(targets.has("users")).toBe(true);
    expect(targets.has("work_item_types")).toBe(true);
    // users target tracks the single-id PK
    expect(targets.get("users")?.pk).toBe("id");
  });
});

describe("orphanProbeSql — generic dangling-FK detector", () => {
  it("LEFT JOINs child→parent and finds non-null FKs with no parent", () => {
    const sql = orphanProbeSql({
      childTable: "work_items",
      childColumn: "work_item_type_id",
      parentTable: "work_item_types",
      parentColumn: "id",
      constraint: "fk_test",
      hardFk: true,
    });
    expect(sql).toContain('FROM "work_items" child LEFT JOIN "work_item_types" parent');
    expect(sql).toContain('child."work_item_type_id" = parent."id"');
    expect(sql).toContain('child."work_item_type_id" IS NOT NULL AND parent."id" IS NULL');
    expect(sql).toContain("LIMIT 1");
  });
});

describe("discoverOrphanProbeTargets — catalog FKs + bare user refs", () => {
  // Fake pg client returning a tiny pg_constraint result + zero rows for any other query.
  function fakeClient(fkRows: Array<Record<string, unknown>>) {
    return {
      query: async (q: unknown) => {
        const text = typeof q === "string" ? q : (q as { text: string }).text;
        if (text.includes("pg_constraint")) return { rows: fkRows };
        return { rows: [] };
      },
    } as unknown as Parameters<typeof discoverOrphanProbeTargets>[0];
  }

  it("includes a migrated-table catalog FK and the bare user refs; skips non-migrated children", async () => {
    const targets = await discoverOrphanProbeTargets(
      fakeClient([
        {
          constraint: "work_items_work_item_type_id_fkey",
          child_table: "work_items",
          parent_table: "work_item_types",
          child_column: "work_item_type_id",
          parent_column: "id",
          nkeys: 1,
        },
        {
          // a FK whose child is NOT a migrated table — must be skipped
          constraint: "some_v2_only_fkey",
          child_table: "egress_decisions",
          parent_table: "users",
          child_column: "user_id",
          parent_column: "id",
          nkeys: 1,
        },
      ]),
      plans,
    );
    // the migrated catalog FK is present
    expect(
      targets.find((t) => t.childTable === "work_items" && t.childColumn === "work_item_type_id" && t.hardFk),
    ).toBeTruthy();
    // the non-migrated child FK is dropped
    expect(targets.find((t) => t.childTable === "egress_decisions")).toBeUndefined();
    // bare user refs are added (e.g. notes.author_id) with hardFk=false → users
    const bare = targets.find((t) => t.childTable === "notes" && t.childColumn === "author_id");
    expect(bare).toMatchObject({ parentTable: "users", hardFk: false });
  });

  it("skips composite FKs (probe handles single-column)", async () => {
    const targets = await discoverOrphanProbeTargets(
      fakeClient([
        {
          constraint: "composite_fkey",
          child_table: "work_items",
          parent_table: "work_item_types",
          child_column: "work_item_type_id",
          parent_column: "id",
          nkeys: 2,
        },
      ]),
      plans,
    );
    expect(targets.find((t) => t.constraint === "composite_fkey")).toBeUndefined();
  });
});

describe("migratedTableSet", () => {
  it("is the set of migrated physical tables", () => {
    const s = migratedTableSet(plans);
    expect(s.has("work_items")).toBe(true);
    expect(s.has("users")).toBe(true);
    expect(s.has("egress_decisions")).toBe(false); // v2-only, not migrated
  });
});
