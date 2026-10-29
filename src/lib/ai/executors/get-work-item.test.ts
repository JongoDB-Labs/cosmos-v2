// @vitest-environment node
//
// `get_work_item` is the read Cosmo did not have: the ticket BODY.
//
// Every other read projection omits `description` — listWorkItems selects 14
// structural fields without it, queryWorkItems the same, SEARCH_FIELDS offers
// nine of which none is the body. So the agent could WRITE a description and
// never read one back, and "what does this ticket ask for" had only a
// 240-character semantic-search snippet to work from.
//
// The gate matters as much as the field: existing in the org is not access, and
// a refusal must not tell the caller whether the row is real.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";

const { prisma, prismaUnfiltered, requireProjectRead } = vi.hoisted(() => ({
  prisma: { workItem: { findFirst: vi.fn() } },
  prismaUnfiltered: { orgMember: { findMany: vi.fn() } },
  requireProjectRead: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma, prismaUnfiltered }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead }));

import { getWorkItem } from "./work-items";
import type { AuthContext } from "@/lib/rbac/check";
import type { ToolContext } from "@/lib/ai/executors/_ctx";
import { stubAuth, stubToolCtx } from "@/lib/testing/tool-auth";

const ORG = "org-1";
const ME = "11111111-1111-4111-a111-111111111111";
const ITEM = "22222222-2222-4222-a222-222222222222";
const PROJECT = "33333333-3333-4333-a333-333333333333";

const ctx: ToolContext = stubToolCtx(ORG, ME);
const setActor = (actor: Partial<Omit<AuthContext, "orgId" | "userId">>) => {
  ctx.auth = stubAuth(ctx.orgId, ctx.userId, actor);
};

const ROW = {
  id: ITEM, ticketNumber: 42, title: "Login fails on Safari",
  description: "Steps: 1. open /login in Safari 17. 2. submit. Expected a session; got a 400.",
  columnKey: "todo", priority: "HIGH", assigneeId: ME, createdById: ME,
  intervalId: null, parentId: null, teamId: null, storyPoints: 3,
  startDate: null, dueDate: null, completedAt: null, workItemTypeId: "t1",
  tags: ["bug"], archivedAt: null, projectId: PROJECT,
  createdAt: new Date("2026-10-01"), updatedAt: new Date("2026-10-02"),
};

beforeEach(() => {
  vi.clearAllMocks();
  setActor({ orgRole: "MEMBER", permissions: Permission.ITEM_READ, abacRules: [] });
  prisma.workItem.findFirst.mockResolvedValue(ROW);
  prismaUnfiltered.orgMember.findMany.mockResolvedValue([
    { userId: ME, user: { displayName: "Dana Scully" } },
  ]);
  requireProjectRead.mockResolvedValue(undefined);
});

describe("get_work_item", () => {
  it("ASKS the database for the description", async () => {
    // This assertion is on the SELECT, not on the result, and that is
    // deliberate. `prisma` is mocked, so it hands back the fixture whatever the
    // select says — the obvious test ("the result contains description")
    // passed with `description: true` deleted from the query. A mocked Prisma
    // cannot see a select change, so the select is what has to be asserted.
    await getWorkItem({ itemId: ITEM }, ctx);

    const select = prisma.workItem.findFirst.mock.calls.at(-1)?.[0]?.select;
    expect(select).toMatchObject({ description: true });
    // Control: the select really is the shape being inspected.
    expect(select).toMatchObject({ id: true, title: true });
  });

  it("passes the description through to the caller", async () => {
    // The pairing with the test above: one proves it is requested, this proves
    // nothing strips it on the way out.
    const out = await getWorkItem({ itemId: ITEM }, ctx);

    expect(out).toMatchObject({ description: ROW.description, title: ROW.title, ticketNumber: 42 });
  });

  it("names the assignee and the reporter instead of leaving ids", async () => {
    const out = await getWorkItem({ itemId: ITEM }, ctx);

    expect(out).toMatchObject({ assigneeName: "Dana Scully", reporterName: "Dana Scully", reporterId: ME });
    // `createdById` is renamed to reporterId on the way out — the rest of the
    // agent surface says "reporter", so leaking the column name is a wart.
    expect(out).not.toHaveProperty("createdById");
  });

  it("REFUSES without ITEM_READ, before touching the database", async () => {
    setActor({ orgRole: "MEMBER", permissions: 0n, abacRules: [] });

    const out = await getWorkItem({ itemId: ITEM }, ctx);

    expect(out).toEqual({ error: "Insufficient permissions" });
    expect(prisma.workItem.findFirst).not.toHaveBeenCalled();
  });

  it("existing in the org is NOT access: a closed project reads as not found", async () => {
    // The project may be team-scoped. ITEM_READ is held by MEMBER and VIEWER
    // alike, so it authorises reading SOME item and says nothing about THIS one.
    requireProjectRead.mockRejectedValue(new Error("forbidden"));

    const out = await getWorkItem({ itemId: ITEM }, ctx);

    expect(out).toEqual({ error: "Work item not found" });
  });

  it("gives the SAME answer for a closed project and a missing row", async () => {
    // Distinguishable refusals are how a caller enumerates what exists.
    requireProjectRead.mockRejectedValue(new Error("forbidden"));
    const closed = await getWorkItem({ itemId: ITEM }, ctx);

    vi.clearAllMocks();
    setActor({ orgRole: "MEMBER", permissions: Permission.ITEM_READ, abacRules: [] });
    prisma.workItem.findFirst.mockResolvedValue(null);
    const missing = await getWorkItem({ itemId: ITEM }, ctx);

    expect(closed).toEqual(missing);
  });

  it("gates on the item's OWN project, not one the caller supplied", async () => {
    await getWorkItem({ itemId: ITEM }, ctx);

    expect(requireProjectRead).toHaveBeenCalledWith(expect.anything(), PROJECT, "ITEM_READ");
  });

  it("rejects a non-uuid id at parse time rather than querying", async () => {
    const out = await getWorkItem({ itemId: "ACME-123" }, ctx);

    expect(out).toHaveProperty("error");
    expect(prisma.workItem.findFirst).not.toHaveBeenCalled();
  });

  it("reports archived as a boolean", async () => {
    prisma.workItem.findFirst.mockResolvedValue({ ...ROW, archivedAt: new Date("2026-10-03") });

    const out = await getWorkItem({ itemId: ITEM }, ctx);

    expect(out).toMatchObject({ archived: true });
  });
});
