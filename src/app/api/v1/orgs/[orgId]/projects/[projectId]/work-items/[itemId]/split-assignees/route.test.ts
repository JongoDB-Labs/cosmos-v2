// @vitest-environment node
//
// COSMOS-89: Split per assignee. The original keeps its first assignee; every
// other assignee gets a copy with the same planning fields and parent, linked
// back to the original. Prisma is mocked so this runs without the e2e DB.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { prisma, tx, getAuthContext, requireAccess } = vi.hoisted(() => {
  const tx = {
    workItem: {
      aggregate: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(),
      // The single writer reads rows around a write for their outbox events.
      findMany: vi.fn(async () => []),
      findUniqueOrThrow: vi.fn(async () => ({
        orgId: "o1", projectId: "p1", ticketNumber: 100, columnKey: "todo", workItemTypeId: "t1", parentId: null,
      })),
    },
    workItemAssignee: { deleteMany: vi.fn(), create: vi.fn() },
    workItemLink: { create: vi.fn() },
    activity: { create: vi.fn() },
    domainEvent: { createMany: vi.fn() },
    // A nested transaction joins the open one.
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  return {
    tx,
    prisma: {
      organization: { findUnique: vi.fn() },
      workItem: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
    getAuthContext: vi.fn(),
    requireAccess: vi.fn(),
  };
});
// Visibility is covered against a real database (lib/rbac/team-scope-writes.db.test.ts).
vi.mock("@/lib/rbac/require-project-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rbac/require-project-read")>()),
  requireProjectVisible: vi.fn(async () => undefined),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/abac/require-access", () => ({ requireAccess }));
vi.mock("@/lib/work-items/allocate", () => ({ allocateTicketNumber: vi.fn(async () => 100) }));
vi.mock("@/lib/work-items/labels", () => ({ setWorkItemLabels: vi.fn() }));
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: vi.fn() }));

import { POST } from "./route";

const SOURCE = {
  id: "src",
  orgId: "o1",
  projectId: "p1",
  title: "Write the runbook",
  description: "Each of us writes our section",
  columnKey: "todo",
  assigneeId: "ann",
  priority: "HIGH",
  intervalId: "sprint-3",
  parentId: "epic-1",
  teamId: "team-a",
  storyPoints: 3,
  dueDate: new Date("2026-11-01"),
  startDate: new Date("2026-10-25"),
  workCategory: "BUSINESS",
  highlight: null,
  tags: [],
  customFields: { env: "prod" },
  workItemTypeId: "task",
  ticketNumber: 42,
  createdById: "ann",
  assignees: [{ userId: "ann" }, { userId: "bo" }, { userId: "cy" }],
};

const call = () =>
  POST(new NextRequest("http://x/split", { method: "POST" }), {
    params: Promise.resolve({ orgId: "o1", projectId: "p1", itemId: "src" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: "o1", slug: "acme" });
  getAuthContext.mockResolvedValue({ userId: "pm", orgId: "o1" });
  requireAccess.mockResolvedValue(undefined);
  prisma.workItem.findFirst.mockResolvedValue(SOURCE);
  tx.workItem.aggregate.mockResolvedValue({ _max: { sortOrder: 7 } });
  tx.workItem.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    id: `copy-${data.assigneeId}`,
  }));
});

describe("POST split-assignees", () => {
  it("leaves the original with only its first assignee", async () => {
    const res = await call();
    expect(res.status).toBe(201);

    expect(tx.workItemAssignee.deleteMany).toHaveBeenCalledWith({
      where: { workItemId: "src", userId: { in: ["bo", "cy"] } },
    });
    expect(tx.workItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["src"] } },
      data: { assigneeId: "ann" },
    });
  });

  it("gives every other assignee a copy with the same fields and parent", async () => {
    await call();

    const made = tx.workItem.create.mock.calls.map(([a]) => a.data);
    expect(made.map((d) => d.assigneeId)).toEqual(["bo", "cy"]);
    for (const d of made) {
      expect(d).toMatchObject({
        title: "Write the runbook",
        description: "Each of us writes our section",
        parentId: "epic-1",
        intervalId: "sprint-3",
        teamId: "team-a",
        priority: "HIGH",
        storyPoints: 3,
        columnKey: "todo",
        workItemTypeId: "task",
        customFields: { env: "prod" },
      });
    }
    // Each copy owns its own assignee row and its own ticket number.
    expect(tx.workItemAssignee.create.mock.calls.map(([a]) => a.data.userId)).toEqual(["bo", "cy"]);
    expect(made.map((d) => d.ticketNumber)).toEqual([100, 101]);
  });

  it("links each copy back to the original as a clone", async () => {
    await call();

    expect(tx.workItemLink.create.mock.calls.map(([a]) => a.data)).toEqual([
      { orgId: "o1", sourceItemId: "copy-bo", targetItemId: "src", type: "CLONES" },
      { orgId: "o1", sourceItemId: "copy-cy", targetItemId: "src", type: "CLONES" },
    ]);
  });

  it("refuses an item with a single assignee and changes nothing", async () => {
    prisma.workItem.findFirst.mockResolvedValue({ ...SOURCE, assignees: [{ userId: "ann" }] });

    const res = await call();

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("needs ITEM_UPDATE on the original as well as ITEM_CREATE", async () => {
    await call();

    expect(requireAccess.mock.calls.map(([, action]) => action)).toEqual(["ITEM_UPDATE", "ITEM_CREATE"]);
  });
});
