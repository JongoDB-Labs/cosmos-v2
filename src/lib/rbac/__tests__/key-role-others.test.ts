// @vitest-environment node
//
// The other places an org or project role grants a write that no bit check
// sees: comment moderation (REST and the assistant), deleting a chat channel,
// managing boards, administering other people's saved filters. A key minted by
// an admin acts there by role only when its own scopes grant the matching bit.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole, ProjectRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER = "99999999-9999-4999-8999-999999999999";

const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  projectRole: { value: null as string | null },
  deleted: [] as string[],
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead: async () => undefined }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: async () => ({ id: ORG, slug: "acme" }) },
    orgMember: { findUnique: async () => ({ id: "om1" }) },
    projectMember: {
      findFirst: async () => (h.projectRole.value ? { id: "pm1", role: h.projectRole.value } : null),
    },
    workItem: { findFirst: async () => ({ projectId: PROJECT }) },
    comment: {
      // Someone else's comment.
      findFirst: async () => ({ id: "c1", authorId: OTHER, workItemId: "w1", orgId: ORG }),
      delete: async () => { h.deleted.push("comment"); return {}; },
    },
    chatChannel: {
      findUnique: async () => ({ isGeneral: false, orgId: ORG }),
      delete: async () => { h.deleted.push("channel"); return {}; },
    },
  },
}));

import { roleCountsFor } from "../key-role";
import { canManageBoardsInProject } from "../project-role";
import { DELETE as deleteItemComment } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/[commentId]/route";
import { DELETE as deleteChannel } from "@/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/route";
import { deleteComment } from "@/lib/ai/executors/comments";

const ITEMS_WRITE_MASK = Permission.PROJECT_READ | Permission.ITEM_READ | Permission.ITEM_CREATE |
  Permission.ITEM_UPDATE | Permission.COMMENT_CREATE | Permission.COMMENT_READ;
const as = (orgRole: OrgRole, over: Partial<AuthContext> = {}): AuthContext => ({
  userId: "u1", orgId: ORG, orgRole, permissions: ITEMS_WRITE_MASK, basePermissions: ITEMS_WRITE_MASK, abacRules: [], ...over,
});
const ownerKey = (scopes: string[]) => as(OrgRole.OWNER, { isApiKey: true, scopes });
const ownerSession = () => as(OrgRole.OWNER, { permissions: -1n, basePermissions: -1n });

beforeEach(() => {
  vi.clearAllMocks();
  h.projectRole.value = null;
  h.deleted.length = 0;
});

describe("roleCountsFor", () => {
  it("a session's role always counts; a key's only when its scopes grant the bit", () => {
    expect(roleCountsFor(as(OrgRole.OWNER), Permission.CHAT_USE)).toBe(true);
    expect(roleCountsFor(ownerKey(["items:write"]), Permission.PROJECT_UPDATE)).toBe(true);
    expect(roleCountsFor(ownerKey(["read"]), Permission.PROJECT_UPDATE)).toBe(false);
    expect(roleCountsFor(ownerKey([]), Permission.PROJECT_UPDATE)).toBe(false);
  });

});

describe("comment moderation", () => {
  const del = () =>
    deleteItemComment(new NextRequest("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ orgId: ORG, projectId: PROJECT, itemId: "w1", commentId: "c1" }),
    });

  it("an OWNER's items:write key can't delete someone else's comment (moderation is a delete)", async () => {
    h.getAuthContext.mockResolvedValue(ownerKey(["items:write"]));
    expect((await del()).status).toBe(403);
    expect(h.deleted).toEqual([]);
  });

  it("the project MANAGER's read key can't either", async () => {
    h.projectRole.value = ProjectRole.MANAGER;
    h.getAuthContext.mockResolvedValue(as(OrgRole.MEMBER, { isApiKey: true, scopes: ["read"] }));
    expect((await del()).status).toBe(403);
  });

  it("an OWNER's browser session still moderates", async () => {
    h.getAuthContext.mockResolvedValue(ownerSession());
    expect((await del()).status).toBe(204);
    expect(h.deleted).toEqual(["comment"]);
  });

  it("the assistant's delete_comment follows the same rule", async () => {
    const key = ownerKey(["items:write"]);
    expect(await deleteComment({ commentId: "44444444-4444-4444-8444-444444444444" }, { orgId: ORG, userId: "u1", auth: key })).toMatchObject({
      error: expect.stringMatching(/author or an admin/),
    });
    expect(h.deleted).toEqual([]);
    const session = ownerSession();
    expect(await deleteComment({ commentId: "44444444-4444-4444-8444-444444444444" }, { orgId: ORG, userId: "u1", auth: session })).not.toHaveProperty("error");
    expect(h.deleted).toEqual(["comment"]);
  });
});

describe("deleting a chat channel", () => {
  const del = () =>
    deleteChannel(new NextRequest("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ orgId: ORG, channelId: "ch1" }),
    });

  it("an OWNER's key never deletes a channel by role", async () => {
    h.getAuthContext.mockResolvedValue(ownerKey(["read", "items:write"]));
    expect((await del()).status).toBe(403);
    expect(h.deleted).toEqual([]);
  });

  it("an OWNER's browser session still does", async () => {
    h.getAuthContext.mockResolvedValue(ownerSession());
    expect((await del()).status).not.toBe(403);
  });
});

describe("managing boards", () => {
  it("an OWNER's or a LEAD's key doesn't manage boards by role (no scope grants BOARD_CREATE)", async () => {
    expect(await canManageBoardsInProject(ownerKey(["items:write"]), PROJECT)).toBe(false);
    h.projectRole.value = ProjectRole.LEAD;
    expect(await canManageBoardsInProject(as(OrgRole.MEMBER, { isApiKey: true, scopes: ["items:write"] }), PROJECT)).toBe(false);
  });

  it("their browser sessions still do", async () => {
    expect(await canManageBoardsInProject(as(OrgRole.OWNER), PROJECT)).toBe(true);
    h.projectRole.value = ProjectRole.LEAD;
    expect(await canManageBoardsInProject(as(OrgRole.MEMBER), PROJECT)).toBe(true);
  });
});
