// @vitest-environment node
//
// A work item's change history returns before/after values only for an
// allowlist of the item's own fields (lib/work-items/read.server.ts). Every
// field the writers record today is on it, so nothing changes; a writer that
// starts recording a new field shows that field's values as null until it is
// reviewed and added, and the scan below fails so the review happens.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({
  ORG: "11111111-1111-4111-8111-111111111111",
  PROJECT: "22222222-2222-4222-8222-222222222222",
  ITEM: "33333333-3333-4333-8333-333333333333",
  rows: [] as unknown[],
}));
vi.mock("@/lib/auth/session", () => ({
  getAuthContext: async () => ({
    userId: "u1", orgId: h.ORG, orgRole: OrgRole.MEMBER,
    permissions: Permission.ITEM_READ, basePermissions: Permission.ITEM_READ, abacRules: [],
  }),
}));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead: async () => {} }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: async () => ({ id: h.ORG, slug: "acme", settings: {} }) },
    workItem: {
      findFirst: async (args: { include?: unknown }) =>
        args?.include ? { id: h.ITEM, comments: [], activities: h.rows } : { id: h.ITEM },
    },
    activity: { findMany: async () => h.rows },
  },
}));

import { ACTIVITY_VALUE_FIELDS, loadWorkItemDetail, projectActivityValues } from "@/lib/work-items/read.server";
import { GET as listActivity } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/activity/route";

const row = (field: string | null, oldValue: string | null, newValue: string | null) => ({
  id: "44444444-4444-4444-8444-444444444444", orgId: h.ORG, workItemId: h.ITEM, subjectType: null, subjectId: null,
  userId: "55555555-5555-4555-8555-555555555555", action: field ? "updated" : "commented", field, oldValue, newValue,
  createdAt: new Date("2026-10-24T00:00:00Z"),
});

describe("activity values", () => {
  it("keeps the values of an allowlisted field, and of an action with no field", () => {
    const kept = [row("priority", "LOW", "HIGH"), row(null, null, null)];
    expect(projectActivityValues(kept)).toEqual(kept);
  });

  it("nulls the values of any other field, keeping that it changed", () => {
    const [out] = projectActivityValues([row("description", "old secret", "new secret")]);
    expect(out).toMatchObject({ field: "description", oldValue: null, newValue: null });
  });

  it("the route answers with the projected values", async () => {
    h.rows = [row("title", "A", "B"), row("description", "old secret", "new secret")];
    const res = await listActivity(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ orgId: h.ORG, projectId: h.PROJECT, itemId: h.ITEM }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((r: { oldValue: string | null }) => r.oldValue)).toEqual(["A", null]);
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("the detail's embedded history is projected the same way", async () => {
    h.rows = [row("title", "A", "B"), row("description", "old secret", "new secret")];
    const ctx = {
      userId: "u1", orgId: h.ORG, orgRole: OrgRole.MEMBER,
      permissions: Permission.ITEM_READ, basePermissions: Permission.ITEM_READ, abacRules: [],
    };
    const item = await loadWorkItemDetail(ctx, h.ORG, h.PROJECT, h.ITEM);
    expect(item!.activities.map((r) => r.oldValue)).toEqual(["A", null]);
  });
});

describe("every field the work-item writers record is reviewed", () => {
  // The writers of work-item activity: the change service, the schedule
  // cascade, and merge. A field they record that isn't on the allowlist would
  // lose its values in the history the UI shows; add it once it is reviewed.
  const recorded = (file: string) =>
    [...readFileSync(file, "utf8").matchAll(/field: "([A-Za-z]+)"/g)].map((m) => m[1]);

  it.each([
    "src/lib/work-items/apply-change.server.ts",
    "src/lib/work-items/merge.server.ts",
  ])("%s", (file) => {
    const fields = recorded(file);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.filter((f) => !ACTIVITY_VALUE_FIELDS.has(f))).toEqual([]);
  });

  it("src/lib/work-items/schedule-cascade-io.ts (its dates)", () => {
    const src = readFileSync("src/lib/work-items/schedule-cascade-io.ts", "utf8");
    const fields = [...src.matchAll(/for \(const field of \[([^\]]+)\]/g)].flatMap((m) => [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]));
    expect(fields).toEqual(["startDate", "dueDate"]);
    expect(fields.filter((f) => !ACTIVITY_VALUE_FIELDS.has(f))).toEqual([]);
  });
});
