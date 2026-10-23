// @vitest-environment node
//
// COSMOS-222: "ask Cosmo what my team has going on this week" had no way in.
// No tool listed a project's teams or said which the asker was on, and neither
// work-item tool could filter by team.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";
import { projectStructural } from "@/lib/ai/egress/projection";
import { itemMatchesTeam, teamWorkItemWhere, teamsByUser } from "@/lib/teams/item-teams";

const { prisma, loadEffectivePermissions, getReadableProjectIds, requireProjectRead } =
  vi.hoisted(() => ({
    prisma: {
      workItem: { findMany: vi.fn() },
      orgMember: { findMany: vi.fn() },
      team: { findMany: vi.fn(), findFirst: vi.fn() },
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

const ME = "11111111-1111-4111-a111-111111111111";
const OTHER = "33333333-3333-4333-a333-333333333333";
const PROJECT = "22222222-2222-4222-a222-222222222222";
const TEAM = "55555555-5555-4555-a555-555555555555";
const ctx = { orgId: "org-1", userId: ME };

const member = (userId: string) => ({ projectMember: { orgMember: { userId } } });

const lastItemArgs = () =>
  prisma.workItem.findMany.mock.calls.at(-1)?.[0] as {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
  };

beforeEach(() => {
  vi.clearAllMocks();
  loadEffectivePermissions.mockResolvedValue({
    orgRole: "MEMBER",
    permissions: Permission.ITEM_READ | Permission.PROJECT_READ,
    basePermissions: Permission.ITEM_READ | Permission.PROJECT_READ,
    abacRules: [],
  });
  getReadableProjectIds.mockResolvedValue([PROJECT]);
  requireProjectRead.mockResolvedValue(undefined);
  prisma.workItem.findMany.mockResolvedValue([]);
  prisma.orgMember.findMany.mockResolvedValue([]);
  prisma.team.findFirst.mockResolvedValue({
    id: TEAM,
    projectId: PROJECT,
    members: [member(ME), member(OTHER)],
  });
});

describe("list_teams", () => {
  it("lists a project's teams and marks the ones the asker is on", async () => {
    prisma.team.findMany.mockResolvedValue([
      { id: TEAM, projectId: PROJECT, name: "Alpha", key: "A", members: [member(ME), member(OTHER)] },
      { id: "t2", projectId: PROJECT, name: "Bravo", key: null, members: [member(OTHER)] },
    ]);

    const res = (await executeTool("list_teams", { projectId: PROJECT }, ctx)) as {
      teams: { id: string; isMine: boolean; memberCount: number }[];
    };

    expect(res.teams.map((t) => [t.id, t.isMine, t.memberCount])).toEqual([
      [TEAM, true, 2],
      ["t2", false, 1],
    ]);
  });

  it("refuses a project the asker cannot read", async () => {
    requireProjectRead.mockRejectedValue(new Error("nope"));

    const res = (await executeTool("list_teams", { projectId: PROJECT }, ctx)) as { error?: string };

    expect(res.error).toBe("Project not found");
    expect(prisma.team.findMany).not.toHaveBeenCalled();
  });
});

describe.each(["query_work_items", "list_work_items"])("%s — teamId", (tool) => {
  it("filters to the team's work: owned items, plus unowned items its members hold", async () => {
    await executeTool(tool, { projectId: PROJECT, teamId: TEAM }, ctx);

    expect(lastItemArgs().where.AND).toEqual([
      { OR: [{ teamId: TEAM }, { teamId: null, assigneeId: { in: [ME, OTHER] } }] },
    ]);
  });

  it("only looks the team up inside projects the asker may read", async () => {
    await executeTool(tool, { projectId: PROJECT, teamId: TEAM }, ctx);

    const where = prisma.team.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: TEAM, orgId: "org-1", projectId: { in: [PROJECT] } });
  });

  it("says the team was not found rather than returning everything", async () => {
    prisma.team.findFirst.mockResolvedValue(null);

    const res = (await executeTool(tool, { projectId: PROJECT, teamId: TEAM }, ctx)) as { error?: string };

    expect(res.error).toBe("Team not found");
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });

  it("refuses a teamId that is not an id instead of querying with it", async () => {
    const res = (await executeTool(tool, { projectId: PROJECT, teamId: "Alpha" }, ctx)) as { error?: string };

    expect(res.error).toBeTruthy();
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });

  it("returns each item's teamId", async () => {
    await executeTool(tool, { projectId: PROJECT }, ctx);

    expect(lastItemArgs().select.teamId).toBe(true);
    expect(lastItemArgs().where).not.toHaveProperty("AND");
  });
});

describe("teamWorkItemWhere", () => {
  // A tiny evaluator for exactly the shape the builder emits, so the query is
  // checked against the board's in-memory rule rather than against itself.
  type Item = { teamId: string | null; assigneeId: string | null };
  type Clause = { teamId?: string | null; assigneeId?: { in: string[] } };
  const matchClause = (i: Item, c: Clause) =>
    (c.teamId === undefined || i.teamId === c.teamId) &&
    (c.assigneeId === undefined || (i.assigneeId !== null && c.assigneeId.in.includes(i.assigneeId)));
  const matches = (i: Item, w: { OR?: Clause[] } & Clause) =>
    w.OR ? w.OR.some((c) => matchClause(i, c)) : matchClause(i, w);

  it("agrees with itemMatchesTeam, the rule the board filter uses", () => {
    const teams = [
      { id: TEAM, name: "Alpha", members: [{ userId: ME }] },
      { id: "t2", name: "Bravo", members: [{ userId: OTHER }] },
    ];
    const byUser = teamsByUser(teams);
    const items: Item[] = [
      { teamId: TEAM, assigneeId: OTHER }, // owned by Alpha, though a Bravo member holds it
      { teamId: "t2", assigneeId: ME }, // owned by Bravo
      { teamId: null, assigneeId: ME }, // unowned, Alpha's member
      { teamId: null, assigneeId: OTHER }, // unowned, Bravo's member
      { teamId: null, assigneeId: null }, // nobody's
    ];
    const where = teamWorkItemWhere(TEAM, [ME]) as { OR?: Clause[] } & Clause;

    expect(items.map((i) => matches(i, where))).toEqual(
      items.map((i) => itemMatchesTeam(i, TEAM, byUser)),
    );
  });
});

describe("egress projection", () => {
  it("keeps a team's structural fields and drops its name", () => {
    const out = projectStructural(
      { id: TEAM, projectId: PROJECT, name: "Alpha", key: "A", memberCount: 2, isMine: true },
      "team",
    );
    expect(out).toEqual({ id: TEAM, projectId: PROJECT, memberCount: 2, isMine: true });
  });

  it("keeps a work item's teamId", () => {
    const out = projectStructural({ id: "a", teamId: TEAM, title: "x" }, "work_item");
    expect(out).toEqual({ id: "a", teamId: TEAM });
  });
});
