// @vitest-environment node
//
// The TEAM axis of board access.
//
// `visibleBoards` (board-visibility.ts) has always held the rule and has always
// been correct. What was wrong is that only ONE of the five surfaces reaching a
// board called it: the project layout. The API list route, the board-by-id
// route, the board page and Cosmo's `list_boards` each gated the PROJECT axis
// and returned every board in the project regardless of team.
//
// So these tests are about the helper every surface now forwards to, and
// especially about the two things easiest to get wrong when writing it:
//   - a detail refusal must be indistinguishable from "no such board", or the
//     gate becomes an oracle for the team structure it protects;
//   - a board with no team must short-circuit, because that is every existing
//     row and the whole reason this is safe to deploy.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { NotFoundError } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { teamIdsForActor, canManageProject } = vi.hoisted(() => ({
  teamIdsForActor: vi.fn(),
  canManageProject: vi.fn(),
}));
vi.mock("@/lib/rbac/team-membership", () => ({ teamIdsForActor }));
vi.mock("@/lib/rbac/scope", () => ({ canManageProject }));

import {
  narrowBoards,
  isBoardVisible,
  requireBoardRead,
  boardViewerFor,
} from "@/lib/rbac/board-access";

const ORG = "11111111-1111-4111-a111-111111111111";
const ME = "22222222-2222-4222-a222-222222222222";
const PROJECT = "33333333-3333-4333-a333-333333333333";
const TEAM_MINE = "44444444-4444-4444-a444-444444444444";
const TEAM_THEIRS = "55555555-5555-4555-a555-555555555555";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}
function ctxWith(over: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: ME,
    orgId: ORG,
    orgRole: OrgRole.MEMBER,
    permissions: bits("BOARD_READ"),
    basePermissions: bits("BOARD_READ"),
    abacRules: [],
    ...over,
  } as AuthContext;
}

const shared = { id: "b-shared", teamId: null };
const mine = { id: "b-mine", teamId: TEAM_MINE };
const theirs = { id: "b-theirs", teamId: TEAM_THEIRS };

beforeEach(() => {
  vi.clearAllMocks();
  teamIdsForActor.mockResolvedValue([TEAM_MINE]);
  canManageProject.mockResolvedValue(false);
});

describe("narrowBoards — list surfaces", () => {
  it("keeps shared boards and my team's, drops another team's", async () => {
    const out = await narrowBoards(ctxWith(), PROJECT, [shared, mine, theirs]);

    expect(out.map((b) => b.id)).toEqual(["b-shared", "b-mine"]);
  });

  it("keeps every board for an org OWNER", async () => {
    teamIdsForActor.mockResolvedValue([]);

    const out = await narrowBoards(ctxWith({ orgRole: OrgRole.OWNER }), PROJECT, [shared, theirs]);

    expect(out.map((b) => b.id)).toEqual(["b-shared", "b-theirs"]);
  });

  it("keeps every board for a manager of THIS project", async () => {
    // A project a person runs must not be partly invisible to them.
    teamIdsForActor.mockResolvedValue([]);
    canManageProject.mockResolvedValue(true);

    const out = await narrowBoards(ctxWith(), PROJECT, [shared, theirs]);

    expect(out.map((b) => b.id)).toEqual(["b-shared", "b-theirs"]);
  });

  it("shows only shared boards to someone on no team", async () => {
    teamIdsForActor.mockResolvedValue([]);

    const out = await narrowBoards(ctxWith(), PROJECT, [shared, mine, theirs]);

    expect(out.map((b) => b.id)).toEqual(["b-shared"]);
  });

  it("does not query membership for an empty list", async () => {
    const out = await narrowBoards(ctxWith(), PROJECT, []);

    expect(out).toEqual([]);
    expect(teamIdsForActor).not.toHaveBeenCalled();
  });
});

describe("isBoardVisible", () => {
  it("short-circuits a board with no team, without a membership lookup", async () => {
    // Every existing row. This is why the change is inert until somebody
    // assigns a team, and it must not cost a query per board.
    const ok = await isBoardVisible(ctxWith(), PROJECT, shared);

    expect(ok).toBe(true);
    expect(teamIdsForActor).not.toHaveBeenCalled();
  });

  it("refuses another team's board", async () => {
    expect(await isBoardVisible(ctxWith(), PROJECT, theirs)).toBe(false);
  });

  it("allows my own team's board", async () => {
    expect(await isBoardVisible(ctxWith(), PROJECT, mine)).toBe(true);
  });
});

describe("requireBoardRead — detail surfaces reached by URL", () => {
  it("throws NotFound for another team's board", async () => {
    await expect(requireBoardRead(ctxWith(), PROJECT, theirs)).rejects.toThrow(NotFoundError);
  });

  it("does NOT distinguish hidden from missing", async () => {
    // The actor can see the PROJECT here, so a 403 would confirm that a board
    // exists on it which they may not open — an enumeration oracle for exactly
    // the team structure this protects. Both cases must be the same error.
    const hidden = await requireBoardRead(ctxWith(), PROJECT, theirs).catch((e) => e);
    const missing = await requireBoardRead(ctxWith(), PROJECT, null).catch((e) => e);

    expect(hidden).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(hidden.message).toBe(missing.message);
  });

  it("passes a board the actor may open", async () => {
    await expect(requireBoardRead(ctxWith(), PROJECT, mine)).resolves.toBeUndefined();
  });
});

describe("boardViewerFor — one derivation, reused", () => {
  it("treats an org-wide PROJECT_MANAGE holder as a board admin", async () => {
    // Reproduces the project layout's derivation verbatim. Asserted here so a
    // change to either one breaks visibly rather than letting the sidebar and
    // the API quietly answer differently.
    teamIdsForActor.mockResolvedValue([]);

    const viewer = await boardViewerFor(
      ctxWith({ permissions: bits("BOARD_READ", "PROJECT_MANAGE") }),
      PROJECT,
    );

    expect(viewer.isProjectAdmin).toBe(true);
  });

  it("is not a board admin on permissions alone", async () => {
    const viewer = await boardViewerFor(ctxWith(), PROJECT);

    expect(viewer.isProjectAdmin).toBe(false);
    expect(viewer.teamIds).toEqual([TEAM_MINE]);
  });
});
