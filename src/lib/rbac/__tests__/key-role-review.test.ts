// @vitest-environment node
//
// The families ops' review of #1130 added, each driven through its real route:
//   - a channel ADMIN is a role too (whoever creates a channel holds it);
//   - board writes take the boards' own bits, not PROJECT_UPDATE;
//   - project membership, teams and team scoping take PROJECT_MANAGE, so a key
//     can never promote someone to MANAGER or change who can see the project;
//   - other people's files take the delete bit.
// Each negative has its control: the same person's browser session keeps the
// power, and an ordinary member's session never had it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole, ProjectRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const BOARD = "33333333-3333-4333-8333-333333333333";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ME = "88888888-8888-4888-8888-888888888888";

const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  projectRole: { value: null as string | null },
  channelRole: { value: null as string | null },
  writes: [] as string[],
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/auth/api-key", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/api-key")>()),
  resolveAuth: async () => h.getAuthContext(),
}));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead: async () => undefined }));
vi.mock("@/lib/rbac/project-access", async (orig) => ({
  ...(await orig<typeof import("@/lib/rbac/project-access")>()),
  isProjectVisible: async () => true,
}));
vi.mock("@/lib/db/client", () => {
  const write = (name: string) => async () => { h.writes.push(name); return { id: "x" }; };
  return {
    prisma: {
      organization: { findUnique: async () => ({ id: ORG, slug: "acme" }) },
      orgMember: {
        findUnique: async () => ({ id: "om1" }),
        findFirst: async () => ({ id: "om2", userId: OTHER, orgId: ORG }),
      },
      projectMember: {
        findFirst: async () => (h.projectRole.value ? { id: "pm1", role: h.projectRole.value } : null),
        upsert: write("projectMember.upsert"),
      },
      project: { findFirst: async () => ({ id: PROJECT, orgId: ORG }), update: write("project.update") },
      team: { findFirst: async () => null, create: write("team.create") },
      board: { findFirst: async () => ({ id: BOARD, projectId: PROJECT, orgId: ORG }), update: write("board.update"), delete: write("board.delete") },
      chatChannel: {
        findUnique: async () => ({ id: "ch1", orgId: ORG, kind: "CHANNEL", isPrivate: false, isGeneral: false, archivedAt: null, name: "c" }),
        update: write("chatChannel.update"),
      },
      chatChannelMember: {
        findUnique: async () => (h.channelRole.value ? { role: h.channelRole.value } : null),
      },
      chatMessage: {
        findUnique: async () => ({ id: "m1", authorId: OTHER, channelId: "ch1", deletedAt: null, channel: { orgId: ORG } }),
        update: write("chatMessage.update"),
      },
      document: {
        findFirst: async () => ({ id: "d1", orgId: ORG, projectId: PROJECT, uploadedById: OTHER, visibility: "INHERIT", title: "f" }),
        delete: write("document.delete"),
      },
      comment: { deleteMany: write("comment.deleteMany") },
      auditLog: { create: async () => ({}) },
      $transaction: async (fn: unknown) => (typeof fn === "function" ? fn({}) : Promise.all(fn as Promise<unknown>[])),
    },
  };
});

import { PATCH as patchChannel } from "@/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/route";
import { DELETE as deleteMessage } from "@/app/api/v1/orgs/[orgId]/chat/messages/[messageId]/route";
import { PUT as putBoard, DELETE as deleteBoard } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/route";
import { PUT as putMember } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/members/route";
import { POST as createTeam } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/teams/route";
import { canManageDocument } from "@/lib/files/access";

/** A key minted by a MEMBER: their permissions cut to the scope mask. */
const ITEMS_WRITE = Permission.PROJECT_READ | Permission.PROJECT_UPDATE | Permission.ITEM_READ |
  Permission.ITEM_CREATE | Permission.ITEM_UPDATE | Permission.COMMENT_CREATE | Permission.COMMENT_READ |
  Permission.ORG_READ | Permission.CHAT_USE;
const key = (scopes: string[], permissions = ITEMS_WRITE): AuthContext => ({
  userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER, permissions, basePermissions: permissions, abacRules: [],
  isApiKey: true, scopes,
});
/** A MEMBER's browser session: no org-wide board or project-manage bits. */
const session = (): AuthContext => ({
  userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER, permissions: ITEMS_WRITE, basePermissions: ITEMS_WRITE, abacRules: [],
});

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const P = <T extends Record<string, string>>(extra: T = {} as T) => ({ params: Promise.resolve({ orgId: ORG, projectId: PROJECT, ...extra }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.projectRole.value = null;
  h.channelRole.value = null;
  h.writes.length = 0;
});

describe("a channel ADMIN acts by role only when its roles count", () => {
  const patch = () => patchChannel(req("PATCH", { topic: "t" }), { params: Promise.resolve({ orgId: ORG, channelId: "ch1" }) });
  const delMsg = () => deleteMessage(req("DELETE"), { params: Promise.resolve({ orgId: ORG, messageId: "m1" }) });

  it("the channel creator's read key can't edit the channel or delete others' messages", async () => {
    h.channelRole.value = "ADMIN";
    h.getAuthContext.mockResolvedValue(key(["read"], Permission.PROJECT_READ | Permission.ORG_READ));
    expect((await patch()).status).toBe(403);
    expect((await delMsg()).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("the channel creator's items:write key can't either: no scope grants CHAT_USE", async () => {
    h.channelRole.value = "ADMIN";
    h.getAuthContext.mockResolvedValue(key(["items:write"]));
    expect((await patch()).status).toBe(403);
    expect((await delMsg()).status).toBe(403);
  });

  it("the channel ADMIN's browser session still can", async () => {
    h.channelRole.value = "ADMIN";
    h.getAuthContext.mockResolvedValue(session());
    expect((await patch()).status).not.toBe(403);
    expect((await delMsg()).status).not.toBe(403);
  });
});

describe("board writes take the boards' own bits", () => {
  it("a project MANAGER's items:write key can't edit or delete a board (no BOARD_UPDATE/BOARD_DELETE)", async () => {
    h.projectRole.value = ProjectRole.MANAGER;
    h.getAuthContext.mockResolvedValue(key(["items:write"]));
    expect((await putBoard(req("PUT", { name: "B" }), P({ boardId: BOARD }))).status).toBe(403);
    expect((await deleteBoard(req("DELETE"), P({ boardId: BOARD }))).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("the MANAGER's browser session still can", async () => {
    h.projectRole.value = ProjectRole.MANAGER;
    h.getAuthContext.mockResolvedValue(session());
    expect((await deleteBoard(req("DELETE"), P({ boardId: BOARD }))).status).not.toBe(403);
    expect(h.writes).toContain("board.delete");
  });
});

describe("project membership and teams take PROJECT_MANAGE", () => {
  const promote = () => putMember(req("PUT", { orgMemberId: "77777777-7777-4777-8777-777777777777", role: "MANAGER" }), P());
  const team = () => createTeam(req("POST", { name: "T", key: "TT" }), P());

  it("a project MANAGER's items:write key can't promote anyone or create a team", async () => {
    h.projectRole.value = ProjectRole.MANAGER;
    h.getAuthContext.mockResolvedValue(key(["items:write"]));
    expect((await promote()).status).toBe(403);
    expect((await team()).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("an ordinary member's browser session never could", async () => {
    h.getAuthContext.mockResolvedValue(session());
    expect((await promote()).status).toBe(403);
    expect((await team()).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("the MANAGER's browser session still can", async () => {
    h.projectRole.value = ProjectRole.MANAGER;
    h.getAuthContext.mockResolvedValue(session());
    expect((await promote()).status).not.toBe(403);
    expect(h.writes).toContain("projectMember.upsert");
  });
});

describe("other people's files take the delete bit", () => {
  const theirs = { projectId: PROJECT, uploadedById: OTHER };
  const mine = { projectId: PROJECT, uploadedById: ME };

  it("a project MANAGER's items:write key can't manage a file someone else uploaded", async () => {
    h.projectRole.value = ProjectRole.MANAGER;
    expect(await canManageDocument(theirs, key(["items:write"]))).toBe(false);
  });

  it("but still manages its owner's own uploads", async () => {
    expect(await canManageDocument(mine, key(["read"], Permission.PROJECT_READ))).toBe(true);
  });

  it("the MANAGER's browser session still manages others' files", async () => {
    h.projectRole.value = ProjectRole.MANAGER;
    expect(await canManageDocument(theirs, session())).toBe(true);
  });
});
