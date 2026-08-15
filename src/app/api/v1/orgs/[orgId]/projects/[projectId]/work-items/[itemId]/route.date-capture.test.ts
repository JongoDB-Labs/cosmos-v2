// @vitest-environment node
//
// Coverage: actualStart/completedAt auto-capture + manual-override behavior on
// the work-item PUT route. Mirrors the harness in the sibling `route.test.ts`
// (same mocks/hoisted setup) — see that file's header comment for the pattern
// rationale.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";
import { OrgRole } from "@prisma/client";

// --- I/O boundary mocks ------------------------------------------------------
const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    workItem: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    // The route resolves the DESTINATION column's category to decide whether a
    // move means started/finished. Keyed by column key so each test's move lands
    // on a realistic board; "review" is IN_PROGRESS, which is the whole point —
    // its key contains none of the words the old string check looked for.
    boardColumn: {
      findFirst: vi.fn(({ where }: { where: { key?: string } }) => {
        const CATEGORY: Record<string, string> = {
          backlog: "TODO",
          todo: "TODO",
          "to-do": "TODO",
          in_progress: "IN_PROGRESS",
          "in-progress": "IN_PROGRESS",
          review: "IN_PROGRESS",
          qa: "IN_PROGRESS",
          done: "DONE",
          shipped: "DONE",
          cancelled: "CANCELLED",
        };
        const category = CATEGORY[where.key ?? ""];
        return Promise.resolve(category ? { category } : null);
      }),
    },
    activity: { createMany: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

// Best-effort side-effects the PUT path fires — stub so they don't reach real I/O.
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn().mockResolvedValue(undefined) }));

import { PUT } from "./route";

// --- ctx + fixture helpers ---------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const ITEM_ID = "33333333-3333-3333-3333-333333333333";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";

/** Build a permission bitfield from real Permission bits (no magic numbers). */
function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(opts: {
  permissions: bigint;
  abacRules?: AbacRule[];
  orgRole?: OrgRole;
}): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: opts.orgRole ?? OrgRole.MEMBER,
    permissions: opts.permissions,
    basePermissions: opts.permissions,
    abacRules: opts.abacRules ?? [],
  };
}

function putRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/v1/orgs/o/projects/p/work-items/i", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID, itemId: ITEM_ID });

/** Baseline existing-item fixture; individual tests override columnKey /
 *  actualStart / completedAt to set up each scenario. */
function existingFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    title: "Original",
    description: "",
    columnKey: "todo",
    priority: "MEDIUM",
    assigneeId: null,
    intervalId: null,
    workItemTypeId: null,
    createdById: "99999999-9999-9999-9999-999999999999",
    completedAt: null,
    actualStart: null,
    ticketNumber: 7,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(
    ctxWith({ permissions: bits("ITEM_READ", "ITEM_UPDATE") }),
  );
  prisma.$transaction.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => {
    prisma.workItem.update.mockResolvedValue({
      id: ITEM_ID,
      title: "Original",
      description: "",
    });
    prisma.activity.createMany.mockResolvedValue({ count: 1 });
    return cb(prisma);
  });
  logAudit.mockResolvedValue(undefined);
});

describe("PUT /work-items/[itemId] — actualStart/completedAt auto-capture + override", () => {
  it("1. todo → in_progress with no actualStart set auto-captures actualStart", async () => {
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "todo", actualStart: null }),
    );

    const res = await PUT(putRequest({ columnKey: "in_progress" }), { params });

    expect(res.status).toBe(200);
    const updateData = prisma.workItem.update.mock.calls[0][0].data;
    expect(updateData.actualStart).toBeInstanceOf(Date);
  });

  it("2. already in_progress with an actualStart set → not overwritten on further moves", async () => {
    const pastStart = new Date("2026-01-01T00:00:00Z");
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "in_progress", actualStart: pastStart }),
    );

    const res = await PUT(putRequest({ columnKey: "review" }), { params });

    expect(res.status).toBe(200);
    const updateData = prisma.workItem.update.mock.calls[0][0].data;
    expect(updateData.actualStart).toBeUndefined();
  });

  it("3. backlog → todo (still not-started) does not auto-capture actualStart", async () => {
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "backlog", actualStart: null }),
    );

    const res = await PUT(putRequest({ columnKey: "todo" }), { params });

    expect(res.status).toBe(200);
    const updateData = prisma.workItem.update.mock.calls[0][0].data;
    expect(updateData.actualStart).toBeUndefined();
  });

  it("4. manual actualStart in the request wins over auto-capture", async () => {
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "todo", actualStart: null }),
    );

    const res = await PUT(
      putRequest({ columnKey: "in_progress", actualStart: "2026-02-02T00:00:00Z" }),
      { params },
    );

    expect(res.status).toBe(200);
    const updateData = prisma.workItem.update.mock.calls[0][0].data;
    expect(updateData.actualStart.toISOString()).toBe("2026-02-02T00:00:00.000Z");
  });

  // --- date audit ------------------------------------------------------------
  // The incident left NO trail: activities recorded columnKey/intervalId/
  // assigneeId/workItemTypeId/title/priority and no dates at all, so the only way
  // to prove what had happened was to restore a dump and diff it.

  it("A. an AUTO-CAPTURED actualStart is written to the activity trail", async () => {
    // The exact shape of the incident: the client sent only columnKey.
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "todo", actualStart: null }),
    );
    await PUT(putRequest({ columnKey: "in_progress" }), { params });

    const rows = prisma.activity.createMany.mock.calls[0][0].data as {
      field: string;
      oldValue: string | null;
      newValue: string | null;
    }[];
    const audit = rows.find((r) => r.field === "actualStart");
    expect(audit).toBeDefined();
    expect(audit!.oldValue).toBeNull();
    expect(audit!.newValue).toEqual(expect.any(String));
  });

  it("B. an explicit startDate change is audited with both values", async () => {
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ startDate: new Date("2026-07-27T00:00:00Z") }),
    );
    await PUT(putRequest({ startDate: "2026-09-01T00:00:00.000Z" }), { params });

    const rows = prisma.activity.createMany.mock.calls[0][0].data as {
      field: string;
      oldValue: string | null;
      newValue: string | null;
    }[];
    const audit = rows.find((r) => r.field === "startDate");
    expect(audit).toBeDefined();
    expect(audit!.oldValue).toBe("2026-07-27T00:00:00.000Z");
    expect(audit!.newValue).toBe("2026-09-01T00:00:00.000Z");
  });

  it("C. a date set to the SAME value writes no audit row", async () => {
    const same = new Date("2026-07-27T00:00:00Z");
    prisma.workItem.findFirst.mockResolvedValue(existingFixture({ startDate: same }));
    await PUT(putRequest({ startDate: same.toISOString() }), { params });

    const calls = prisma.activity.createMany.mock.calls;
    const rows = (calls[0]?.[0]?.data ?? []) as { field: string }[];
    expect(rows.find((r) => r.field === "startDate")).toBeUndefined();
  });

  it("D. clearing a date records the old value, so it can be restored", async () => {
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ dueDate: new Date("2026-08-30T00:00:00Z") }),
    );
    await PUT(putRequest({ dueDate: null }), { params });

    const rows = prisma.activity.createMany.mock.calls[0][0].data as {
      field: string;
      oldValue: string | null;
      newValue: string | null;
    }[];
    const audit = rows.find((r) => r.field === "dueDate");
    expect(audit).toBeDefined();
    expect(audit!.oldValue).toBe("2026-08-30T00:00:00.000Z");
    expect(audit!.newValue).toBeNull();
  });

  // --- the 2026-08-14 incident -----------------------------------------------
  // A user moved a batch of tickets on the Sprint board and every Gantt bar
  // jumped to that day, which read as "all my start dates were reset".

  it("6. a team-named IN_PROGRESS column (Review) DOES start the clock", async () => {
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "todo", actualStart: null }),
    );
    const res = await PUT(putRequest({ columnKey: "review" }), { params });
    expect(res.status).toBe(200);
    expect(prisma.workItem.update.mock.calls[0][0].data.actualStart).toBeInstanceOf(Date);
  });

  it("7. a TODO column whose key is not in the old blocklist does NOT start the clock", async () => {
    // "on-deck" is TODO but contains none of backlog/todo/to-do, so the old
    // string check treated it as started and stamped today. This is the bug.
    prisma.boardColumn.findFirst.mockResolvedValueOnce({ category: "TODO" });
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "backlog", actualStart: null }),
    );
    const res = await PUT(putRequest({ columnKey: "on-deck" }), { params });
    expect(res.status).toBe(200);
    expect(prisma.workItem.update.mock.calls[0][0].data.actualStart).toBeUndefined();
  });

  it("8. a DONE column not named 'done' still captures the END date", async () => {
    // "shipped" contains none of done/completed/closed.
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "in_progress", actualStart: new Date("2026-01-01"), completedAt: null }),
    );
    const res = await PUT(putRequest({ columnKey: "shipped" }), { params });
    expect(res.status).toBe(200);
    expect(prisma.workItem.update.mock.calls[0][0].data.completedAt).toBeInstanceOf(Date);
  });

  it("9. CANCELLED never stamps a start or an end — abandoning is not delivering", async () => {
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "todo", actualStart: null, completedAt: null }),
    );
    const res = await PUT(putRequest({ columnKey: "cancelled" }), { params });
    expect(res.status).toBe(200);
    const updateData = prisma.workItem.update.mock.calls[0][0].data;
    expect(updateData.actualStart).toBeUndefined();
    expect(updateData.completedAt).toBeUndefined();
  });

  it("10. an unknown column key stamps nothing rather than guessing", async () => {
    prisma.boardColumn.findFirst.mockResolvedValueOnce(null);
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "todo", actualStart: null }),
    );
    const res = await PUT(putRequest({ columnKey: "mystery" }), { params });
    expect(res.status).toBe(200);
    expect(prisma.workItem.update.mock.calls[0][0].data.actualStart).toBeUndefined();
  });

  it("5. manual completedAt in the request wins over auto-capture", async () => {
    prisma.workItem.findFirst.mockResolvedValue(
      existingFixture({ columnKey: "todo", completedAt: null }),
    );

    const res = await PUT(
      putRequest({ columnKey: "done", completedAt: "2026-02-05T00:00:00Z" }),
      { params },
    );

    expect(res.status).toBe(200);
    const updateData = prisma.workItem.update.mock.calls[0][0].data;
    expect(updateData.completedAt.toISOString()).toBe("2026-02-05T00:00:00.000Z");
  });
});
