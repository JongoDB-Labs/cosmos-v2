// @vitest-environment node
//
// COSMOS-89: Split per assignee. The original keeps its first assignee; every
// other assignee gets a copy with the same planning fields and parent, linked
// back to the original. Prisma is mocked so this runs without the e2e DB.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// UUIDs: the route's contract validates the path and its answer.
const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SRC = "33333333-3333-4333-8333-333333333333";
const ANN = "a0000000-0000-4000-8000-000000000001";
const BO = "b0000000-0000-4000-8000-000000000002";
const CY = "c0000000-0000-4000-8000-000000000003";
const PM = "d0000000-0000-4000-8000-000000000004";
const EPIC = "e0000000-0000-4000-8000-000000000005";
const SPRINT = "f0000000-0000-4000-8000-000000000006";
const TEAM = "a1000000-0000-4000-8000-000000000007";
const TASK_TYPE = "a2000000-0000-4000-8000-000000000008";
const COPY_BO = "a3000000-0000-4000-8000-000000000009";
const COPY_CY = "a4000000-0000-4000-8000-00000000000a";

const { prisma, tx, getAuthContext, requireAccess } = vi.hoisted(() => {
  const tx = {
    workItem: {
      aggregate: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(),
      // The single writer reads rows around a write for their outbox events.
      findMany: vi.fn(async () => []),
      findUniqueOrThrow: vi.fn(async () => ({
        orgId: ORG, projectId: PROJECT, ticketNumber: 100, columnKey: "todo", workItemTypeId: TASK_TYPE, parentId: null,
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
  id: SRC,
  orgId: ORG,
  projectId: PROJECT,
  title: "Write the runbook",
  description: "Each of us writes our section",
  columnKey: "todo",
  assigneeId: ANN,
  priority: "HIGH",
  intervalId: SPRINT,
  parentId: EPIC,
  teamId: TEAM,
  storyPoints: 3,
  dueDate: new Date("2026-11-01"),
  startDate: new Date("2026-10-25"),
  workCategory: "BUSINESS",
  highlight: null,
  tags: [],
  customFields: { env: "prod" },
  workItemTypeId: TASK_TYPE,
  ticketNumber: 42,
  createdById: ANN,
  assignees: [{ userId: ANN }, { userId: BO }, { userId: CY }],
};

const call = () =>
  POST(new NextRequest("http://x/split", { method: "POST" }), {
    params: Promise.resolve({ orgId: ORG, projectId: PROJECT, itemId: SRC }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "acme" });
  getAuthContext.mockResolvedValue({ userId: PM, orgId: ORG });
  requireAccess.mockResolvedValue(undefined);
  prisma.workItem.findFirst.mockResolvedValue(SOURCE);
  tx.workItem.aggregate.mockResolvedValue({ _max: { sortOrder: 7 } });
  tx.workItem.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    id: data.assigneeId === BO ? COPY_BO : COPY_CY,
  }));
});

describe("POST split-assignees", () => {
  it("leaves the original with only its first assignee", async () => {
    const res = await call();
    expect(res.status).toBe(201);

    expect(tx.workItemAssignee.deleteMany).toHaveBeenCalledWith({
      where: { workItemId: SRC, userId: { in: [BO, CY] } },
    });
    expect(tx.workItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [SRC] } },
      data: { assigneeId: ANN },
    });
  });

  it("gives every other assignee a copy with the same fields and parent", async () => {
    await call();

    const made = tx.workItem.create.mock.calls.map(([a]) => a.data);
    expect(made.map((d) => d.assigneeId)).toEqual([BO, CY]);
    for (const d of made) {
      expect(d).toMatchObject({
        title: "Write the runbook",
        description: "Each of us writes our section",
        parentId: EPIC,
        intervalId: SPRINT,
        teamId: TEAM,
        priority: "HIGH",
        storyPoints: 3,
        columnKey: "todo",
        workItemTypeId: TASK_TYPE,
        customFields: { env: "prod" },
      });
    }
    // Each copy owns its own assignee row and its own ticket number.
    expect(tx.workItemAssignee.create.mock.calls.map(([a]) => a.data.userId)).toEqual([BO, CY]);
    expect(made.map((d) => d.ticketNumber)).toEqual([100, 101]);
  });

  it("links each copy back to the original as a clone", async () => {
    await call();

    expect(tx.workItemLink.create.mock.calls.map(([a]) => a.data)).toEqual([
      { orgId: ORG, sourceItemId: COPY_BO, targetItemId: SRC, type: "CLONES" },
      { orgId: ORG, sourceItemId: COPY_CY, targetItemId: SRC, type: "CLONES" },
    ]);
  });

  it("refuses an item with a single assignee and changes nothing", async () => {
    prisma.workItem.findFirst.mockResolvedValue({ ...SOURCE, assignees: [{ userId: ANN }] });

    const res = await call();

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("needs ITEM_UPDATE on the original as well as ITEM_CREATE", async () => {
    await call();

    expect(requireAccess.mock.calls.map(([, action]) => action)).toEqual(["ITEM_UPDATE", "ITEM_CREATE"]);
  });
});
