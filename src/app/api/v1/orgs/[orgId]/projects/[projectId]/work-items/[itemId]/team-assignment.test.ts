// @vitest-environment node
//
// COSMOS-186: a work item can be assigned to a TEAM directly.
//
// Two things are pinned here, both about the write itself rather than the UI:
//
//   1. `teamId` reaches the row WITHOUT an assignee. The acceptance criterion is
//      "without requiring an individual assignee", and the assignee branches in
//      this route are elaborate enough (primary + set + promote + clear) that a
//      team assignment quietly riding on one of them would look like it worked.
//   2. A team from ANOTHER project is refused. `WorkItem.teamId` is only
//      FK-constrained to `teams`, so nothing in the database stops one project's
//      item pointing at another project's — or another org's — team.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => {
  const tx = {
    workItem: { update: vi.fn() },
    activity: { createMany: vi.fn() },
    boardColumn: { findFirst: vi.fn() },
    workItemAssignee: { deleteMany: vi.fn(), createMany: vi.fn(), upsert: vi.fn() },
  };
  return {
    getAuthContext: vi.fn(),
    prisma: {
      tx,
      organization: { findUnique: vi.fn() },
      workItem: { findFirst: vi.fn() },
      team: { findFirst: vi.fn() },
      user: { findUnique: vi.fn() },
      project: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: vi.fn() }));
vi.mock("@/lib/integrations/teams-notify", () => ({
  teamsNotify: vi.fn(),
  escapeHtmlBasic: (s: string) => s,
}));
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/feedback/status-sync", () => ({ syncFeedbackForWorkItems: vi.fn() }));
vi.mock("@/lib/work-items/labels", () => ({ setWorkItemLabels: vi.fn() }));

import { PUT } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_ID = "44444444-4444-4444-8444-444444444444";
const OUR_TEAM_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_PROJECT_TEAM_ID = "66666666-6666-4666-8666-666666666666";

function ctx(): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: Permission.ITEM_UPDATE,
    basePermissions: Permission.ITEM_UPDATE,
    abacRules: [],
  };
}

function putRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/orgs/${ORG_ID}/projects/${PROJECT_ID}/work-items/${ITEM_ID}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

const params = Promise.resolve({
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  itemId: ITEM_ID,
});

/** The item as stored: nobody is assigned to it, and it has no team yet. */
const EXISTING = {
  id: ITEM_ID,
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  title: "Retire the legacy ingest path",
  description: "",
  columnKey: "todo",
  assigneeId: null,
  teamId: null,
  intervalId: null,
  workItemTypeId: "wt",
  priority: "MEDIUM",
  ticketNumber: 7,
  createdById: ACTOR_ID,
  customFields: {},
  startDate: null,
  dueDate: null,
  actualStart: null,
  completedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(ctx());
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.workItem.findFirst.mockResolvedValue(EXISTING);
  // `$transaction` keeps the run-the-callback implementation it was created
  // with — clearAllMocks resets calls, not implementations.
  prisma.tx.workItem.update.mockResolvedValue({ ...EXISTING, teamId: OUR_TEAM_ID });
  prisma.tx.activity.createMany.mockResolvedValue({ count: 1 });
  prisma.tx.boardColumn.findFirst.mockResolvedValue(null);
});

describe("PUT work item — team assignment", () => {
  it("sets the team on an item with NO assignee", async () => {
    prisma.team.findFirst.mockResolvedValue({ id: OUR_TEAM_ID });

    const res = await PUT(putRequest({ teamId: OUR_TEAM_ID }), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ teamId: OUR_TEAM_ID });
    // The team lands in the update, and NOTHING about the assignee is touched —
    // no assignee invented, no assignee set rewritten.
    expect(prisma.tx.workItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ITEM_ID },
        data: expect.objectContaining({ teamId: OUR_TEAM_ID }),
      }),
    );
    const { data } = prisma.tx.workItem.update.mock.calls[0][0];
    expect(data).not.toHaveProperty("assigneeId");
    expect(prisma.tx.workItemAssignee.deleteMany).not.toHaveBeenCalled();
    expect(prisma.tx.workItemAssignee.upsert).not.toHaveBeenCalled();
  });

  it("records the change in the activity trail", async () => {
    prisma.team.findFirst.mockResolvedValue({ id: OUR_TEAM_ID });

    await PUT(putRequest({ teamId: OUR_TEAM_ID }), { params });

    expect(prisma.tx.activity.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          field: "teamId",
          oldValue: null,
          newValue: OUR_TEAM_ID,
        }),
      ]),
    });
  });

  it("clears the team when sent null", async () => {
    prisma.tx.workItem.update.mockResolvedValue({ ...EXISTING, teamId: null });

    const res = await PUT(putRequest({ teamId: null }), { params });

    expect(res.status).toBe(200);
    // No lookup for null — there is no team to scope-check.
    expect(prisma.team.findFirst).not.toHaveBeenCalled();
    const { data } = prisma.tx.workItem.update.mock.calls[0][0];
    expect(data.teamId).toBeNull();
  });

  it("refuses a team that belongs to another project", async () => {
    // The scope query finds nothing, because it is scoped by org AND project.
    prisma.team.findFirst.mockResolvedValue(null);

    const res = await PUT(putRequest({ teamId: OTHER_PROJECT_TEAM_ID }), { params });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Team does not belong to this project",
    });
    // Refused before any write — not written and then reconciled.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("scopes the team lookup by org AND project", async () => {
    prisma.team.findFirst.mockResolvedValue({ id: OUR_TEAM_ID });

    await PUT(putRequest({ teamId: OUR_TEAM_ID }), { params });

    expect(prisma.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: OUR_TEAM_ID, orgId: ORG_ID, projectId: PROJECT_ID },
      }),
    );
  });

  it("does not touch the team when the request never mentions it", async () => {
    // Every other field save goes through this route too; an absent `teamId`
    // must leave the item's team alone rather than clearing it.
    prisma.tx.workItem.update.mockResolvedValue({ ...EXISTING, priority: "HIGH" });

    await PUT(putRequest({ priority: "HIGH" }), { params });

    const { data } = prisma.tx.workItem.update.mock.calls[0][0];
    expect(data).not.toHaveProperty("teamId");
  });
});
