// @vitest-environment node
//
// `query_work_items` must not reach tickets on projects the actor cannot open.
//
// This is the widest of the agent's reads: gated on ITEM_READ — held by MEMBER
// and VIEWER — and querying `{ orgId }` with no project narrowing at all. It
// also takes a free-text `query` matched against the title, so it is a SEARCH
// across every ticket in the organisation, including projects with
// `teamScopedAccess` that the asker is not a member of.
//
// The HTTP equivalents (`/work-items/search`, `/work-items/facets`,
// `/work-items/export`) all narrow through `getReadableProjectIds`, which also
// folds in ABAC ITEM_READ denies. The tool narrowed through nothing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";

const { prisma, loadEffectivePermissions, getReadableProjectIds, requireProjectRead } =
  vi.hoisted(() => ({
    prisma: {
      workItem: { findMany: vi.fn(), findFirst: vi.fn() },
      comment: { findMany: vi.fn() },
      interval: { findMany: vi.fn() },
    },
    loadEffectivePermissions: vi.fn(),
    getReadableProjectIds: vi.fn(),
    requireProjectRead: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rbac/effective-permissions", () => ({ loadEffectivePermissions }));
vi.mock("@/lib/work-items/query/scope", () => ({ getReadableProjectIds }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead }));

import { executeTool } from "./tool-executor";

const ORG = "org-1";
const ME = "11111111-1111-4111-a111-111111111111";
const OPEN_PROJECT = "22222222-2222-4222-a222-222222222222";
const HIDDEN_PROJECT = "33333333-3333-4333-a333-333333333333";

const ctx = { orgId: ORG, userId: ME };
const lastWhere = () =>
  prisma.workItem.findMany.mock.calls.at(-1)?.[0]?.where as Record<
    string,
    unknown
  >;

beforeEach(() => {
  vi.clearAllMocks();
  loadEffectivePermissions.mockResolvedValue({
    orgRole: "MEMBER",
    permissions: Permission.ITEM_READ,
    basePermissions: Permission.ITEM_READ,
    abacRules: [],
  });
  // The actor can open ONE of the org's two projects.
  getReadableProjectIds.mockResolvedValue([OPEN_PROJECT]);
  prisma.workItem.findMany.mockResolvedValue([]);
  prisma.interval.findMany.mockResolvedValue([]);
  requireProjectRead.mockResolvedValue(undefined);
});

describe("query_work_items respects project scope", () => {
  it("narrows to projects the actor can actually open", async () => {
    // Without this the tool answers "show me every ticket" with every ticket in
    // the org — the widest read the assistant has.
    await executeTool("query_work_items", {}, ctx);

    expect(getReadableProjectIds).toHaveBeenCalled();
    expect(lastWhere().projectId).toEqual({ in: [OPEN_PROJECT] });
  });

  it("refuses a hidden project named outright", async () => {
    // The tool takes a projectId, so "what's on project X" is a supported ask.
    // Answering it must not bypass the scope the way it used to.
    const out = await executeTool(
      "query_work_items",
      { projectId: HIDDEN_PROJECT },
      ctx,
    );

    expect(out).toHaveProperty("error");
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });

  it("allows a project the actor CAN open", async () => {
    // The control — narrowing must not break the ordinary case.
    await executeTool("query_work_items", { projectId: OPEN_PROJECT }, ctx);

    expect(lastWhere().projectId).toEqual(OPEN_PROJECT);
  });

  it("does not let a title SEARCH span hidden projects", async () => {
    // The subtler half: even without naming a project, a free-text query used
    // to match titles across the whole org, which leaks ticket names.
    await executeTool("query_work_items", { query: "salary" }, ctx);

    expect(lastWhere().projectId).toEqual({ in: [OPEN_PROJECT] });
    expect(lastWhere().title).toBeTruthy();
  });

  it("returns nothing when the actor can open no project at all", async () => {
    // An empty readable set must mean NOTHING, never "no filter".
    getReadableProjectIds.mockResolvedValue([]);

    await executeTool("query_work_items", {}, ctx);

    expect(lastWhere().projectId).toEqual({ in: [] });
  });
});

describe("query_intervals respects project scope", () => {
  beforeEach(() => {
    // SPRINT_READ as well — otherwise the permission gate denies first and the
    // scope check is never reached, which would make these pass for the wrong
    // reason.
    loadEffectivePermissions.mockResolvedValue({
      orgRole: "MEMBER",
      permissions: Permission.ITEM_READ | Permission.SPRINT_READ,
      basePermissions: Permission.ITEM_READ | Permission.SPRINT_READ,
      abacRules: [],
    });
  });

  it("refuses a project the actor cannot open", async () => {
    // Interval names, goals and work-item counts describe a project's plan.
    // SPRINT_READ is held by MEMBER and VIEWER, and the projectId came straight
    // from the caller.
    requireProjectRead.mockRejectedValue(new Error("denied"));

    const out = await executeTool(
      "query_intervals",
      { projectId: HIDDEN_PROJECT },
      ctx,
    );

    expect(out).toHaveProperty("error");
    expect(prisma.interval.findMany).not.toHaveBeenCalled();
  });

  it("allows a project the actor can open", async () => {
    requireProjectRead.mockResolvedValue(undefined);

    await executeTool("query_intervals", { projectId: OPEN_PROJECT }, ctx);

    expect(prisma.interval.findMany).toHaveBeenCalled();
  });
});

describe("list_comments respects the ticket's project scope", () => {
  // NOT reachable by the projectId arch rule — this tool takes a workItemId, so
  // the project has to be resolved from the ticket before it can be checked.
  // That is exactly why it survived: the rule that catches the others is blind
  // to it, and only reading the code finds it.
  const TICKET = "44444444-4444-4444-a444-444444444444";

  beforeEach(() => {
    loadEffectivePermissions.mockResolvedValue({
      orgRole: "MEMBER",
      permissions: Permission.COMMENT_READ,
      basePermissions: Permission.COMMENT_READ,
      abacRules: [],
    });
    prisma.workItem.findFirst.mockResolvedValue({
      id: TICKET,
      projectId: HIDDEN_PROJECT,
    });
    prisma.comment.findMany.mockResolvedValue([
      { id: "c1", content: "the candid bit" },
    ]);
  });

  it("refuses comments on a ticket in a project the actor cannot open", async () => {
    requireProjectRead.mockRejectedValue(new Error("denied"));

    const out = await executeTool("list_comments", { workItemId: TICKET }, ctx);

    expect(out).toHaveProperty("error");
    expect(prisma.comment.findMany).not.toHaveBeenCalled();
  });

  it("does not reveal that the ticket exists", async () => {
    // "Work item not found" rather than a project error: telling the two apart
    // confirms the ticket is real and sits somewhere they cannot look.
    requireProjectRead.mockRejectedValue(new Error("denied"));

    const out = (await executeTool(
      "list_comments",
      { workItemId: TICKET },
      ctx,
    )) as { error: string };

    expect(out.error).toBe("Work item not found");
  });

  it("returns comments on a ticket the actor CAN reach", async () => {
    requireProjectRead.mockResolvedValue(undefined);

    const out = (await executeTool(
      "list_comments",
      { workItemId: TICKET },
      ctx,
    )) as { count: number };

    expect(out.count).toBe(1);
  });
});
