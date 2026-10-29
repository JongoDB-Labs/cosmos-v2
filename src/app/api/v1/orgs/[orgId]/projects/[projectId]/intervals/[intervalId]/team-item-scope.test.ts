// @vitest-environment node
//
// COSMOS-204: a story can sit with a TEAM before an individual picks it up, so
// "which work is this team's?" is no longer answerable from `assigneeId` alone.
// The board filter learned that rule (`teamWorkItemWhere`); the two sprint
// endpoints that scope a ceremony to one squad had not — they narrowed on the
// assignee, so a story handed to Customer Success with nobody on it yet was
// missing from the squad's committed total and from its review.
//
// Both are asserted here together, against the one shared rule, because a panel
// that counts a different set than the board beside it is the drift this guards.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const INTERVAL = "33333333-3333-4333-8333-333333333333";
const BOARD = "44444444-4444-4444-8444-444444444444";
const TEAM = "55555555-5555-4555-8555-555555555555";
const MEMBER = "66666666-6666-4666-8666-666666666666";

const h = vi.hoisted(() => ({
  /** `where` of every workItem.findMany — planning's committed scope is first. */
  itemWheres: [] as unknown[],
  /** `include.workItems.where` of the ceremony's interval read. */
  ceremonyItemWheres: [] as unknown[],
  /** The team's members, so a team with nobody on it can be exercised too. */
  teamMemberIds: [] as string[],
}));

vi.mock("@/lib/auth/session", () => ({
  getAuthContext: async () => ({ userId: "u1", orgId: ORG, permissions: 0n }),
}));
vi.mock("@/lib/rbac/require-project-read", () => ({
  requireProjectRead: async () => {},
  requireProjectVisible: async () => {},
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: async () => ({ id: ORG, slug: "acme" }) },
    project: { findFirst: async () => ({ projectTemplate: { sector: null } }) },
    team: {
      findFirst: async () => ({
        members: h.teamMemberIds.map((userId) => ({
          projectMember: { orgMember: { userId } },
        })),
      }),
    },
    interval: {
      findFirst: async (args: { include?: { workItems?: { where?: unknown } } }) => {
        // The ceremony route reads the interval with its items included; it
        // stops at a missing interval, which is all this test needs from it.
        if (args.include) {
          h.ceremonyItemWheres.push(args.include.workItems?.where);
          return null;
        }
        return { id: INTERVAL, goal: "" };
      },
      findMany: async () => [],
    },
    workItem: {
      findMany: async (args: { where: unknown }) => {
        h.itemWheres.push(args.where);
        return [];
      },
    },
    intervalCapacity: { findMany: async () => [] },
    board: { findFirst: async () => null, findMany: async () => [] },
  },
}));

import { GET as planningGET } from "./planning/route";
import { GET as ceremonyGET } from "./ceremony/route";

const params = Promise.resolve({ orgId: ORG, projectId: PROJECT, intervalId: INTERVAL });

const planning = (query: string) =>
  planningGET(new NextRequest(`http://localhost/planning${query}`), { params });
const ceremony = (query: string) =>
  ceremonyGET(new NextRequest(`http://localhost/ceremony${query}`), { params });

/** The shared rule: the team's own items, plus team-less ones its people own. */
const teamsWork = (memberIds: string[]) => ({
  OR: [{ teamId: TEAM }, { teamId: null, assigneeId: { in: memberIds } }],
});

beforeEach(() => {
  h.itemWheres = [];
  h.ceremonyItemWheres = [];
  h.teamMemberIds = [MEMBER];
});

describe("a squad's sprint work includes the items that name it (COSMOS-204)", () => {
  it("counts committed work the team owns but has not assigned yet", async () => {
    const res = await planning(`?teamId=${TEAM}`);
    expect(res.status).toBe(200);
    expect(h.itemWheres[0]).toEqual({
      orgId: ORG,
      projectId: PROJECT,
      intervalId: INTERVAL,
      ...teamsWork([MEMBER]),
    });
  });

  it("scopes a ceremony to the items that name the team, assignee or not", async () => {
    await ceremony(`?boardId=${BOARD}&teamId=${TEAM}`);
    expect(h.ceremonyItemWheres[0]).toEqual(teamsWork([MEMBER]));
  });

  it("still counts nothing but the team's own items when it has no members", async () => {
    h.teamMemberIds = [];
    const res = await planning(`?teamId=${TEAM}`);
    expect(res.status).toBe(200);
    // Fail closed: an empty squad gets its own items, never the whole project's.
    expect(h.itemWheres[0]).toEqual({
      orgId: ORG,
      projectId: PROJECT,
      intervalId: INTERVAL,
      teamId: TEAM,
    });
  });

  it("leaves both endpoints unscoped when no team is asked for", async () => {
    const res = await planning("");
    expect(res.status).toBe(200);
    expect(h.itemWheres[0]).toEqual({
      orgId: ORG,
      projectId: PROJECT,
      intervalId: INTERVAL,
    });
    await ceremony(`?boardId=${BOARD}`);
    expect(h.ceremonyItemWheres[0]).toEqual({});
  });
});
