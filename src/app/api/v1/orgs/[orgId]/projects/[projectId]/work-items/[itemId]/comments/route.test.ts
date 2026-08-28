// @vitest-environment node
//
// Regression coverage for COSMOS-4: a freshly-posted comment must carry the
// author's resolved display name so the UI never renders the current user as
// "Unknown". The POST handler used to return the raw Comment row (no
// authorName), which the card-detail-sheet appended to state verbatim → the
// name column fell back to "Unknown" until a refetch.
//
// Harness mirrors the sibling work-items route test: mock the I/O boundaries
// (session, prisma, best-effort side-effects), let the pure ABAC engine run,
// and call the exported handler directly with the App-Router params Promise.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, getCurrentUser, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  getCurrentUser: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    workItem: { findFirst: vi.fn() },
    project: { findUnique: vi.fn() },
    orgMember: { findMany: vi.fn() },
    comment: { create: vi.fn() },
    activity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext, getCurrentUser }));
vi.mock("@/lib/db/client", () => ({ prisma }));
// Best-effort side-effects the POST path fires — stub so they never reach I/O.
// Hoisted so the mention test can assert the notification URL it is called with.
const { createNotification } = vi.hoisted(() => ({ createNotification: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ createNotification }));
vi.mock("@/lib/mentions/references", () => ({
  syncReferences: vi.fn().mockResolvedValue(undefined),
}));
// Realtime publish is a best-effort side-effect; mock it so we can assert the
// approve/comment path emits a work-item event (COSMOS-127) without a live bus.
const { publishToOrg } = vi.hoisted(() => ({ publishToOrg: vi.fn() }));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg }));

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const ITEM_ID = "33333333-3333-3333-3333-333333333333";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

function postRequest(content = "Nice work!"): NextRequest {
  return new NextRequest(
    "http://localhost/api/v1/orgs/o/projects/p/work-items/i/comments",
    {
      method: "POST",
      body: JSON.stringify({ content }),
      headers: { "Content-Type": "application/json" },
    },
  );
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID, itemId: ITEM_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.workItem.findFirst.mockResolvedValue({
    id: ITEM_ID,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    title: "Fix the login",
    assigneeId: null,
    ticketNumber: 42,
  });
  prisma.project.findUnique.mockResolvedValue({ key: "ACME" });
  prisma.orgMember.findMany.mockResolvedValue([]);
  // $transaction([...]) resolves to the created rows; the route destructures
  // `const [comment] = ...`, so element 0 is the persisted comment.
  prisma.$transaction.mockResolvedValue([
    {
      id: "55555555-5555-5555-5555-555555555555",
      orgId: ORG_ID,
      workItemId: ITEM_ID,
      authorId: ACTOR_ID,
      content: "Nice work!",
      createdAt: new Date("2026-07-10T00:00:00Z"),
      updatedAt: new Date("2026-07-10T00:00:00Z"),
    },
    { id: "activity-1" },
  ]);
});

describe("POST /work-items/[itemId]/comments — author enrichment (COSMOS-4)", () => {
  it("enriches the response with the current user's name so it never shows 'Unknown'", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("COMMENT_CREATE", "COMMENT_READ")));
    getCurrentUser.mockResolvedValue({
      id: ACTOR_ID,
      email: "ada@acme.test",
      displayName: "Ada Lovelace",
      avatarUrl: "https://cdn.acme.test/ada.png",
    });

    const res = await POST(postRequest(), { params });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.authorName).toBe("Ada Lovelace");
    expect(body.authorAvatarUrl).toBe("https://cdn.acme.test/ada.png");
    // The author can always edit/delete their own fresh comment.
    expect(body.canEdit).toBe(true);
    expect(body.canDelete).toBe(true);
  });

  it("returns null (not 'Unknown') for authorName when the user has no display name", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("COMMENT_CREATE", "COMMENT_READ")));
    getCurrentUser.mockResolvedValue(null);

    const res = await POST(postRequest(), { params });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.authorName).toBeNull();
    expect(body.authorAvatarUrl).toBeNull();
  });

  it("rejects a ctx without COMMENT_CREATE with 403 and never writes", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("COMMENT_READ")));

    const res = await POST(postRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("POST /work-items/[itemId]/comments — live updates (COSMOS-127)", () => {
  it("publishes a work-item.updated event so open boards + the Foreman console refresh", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("COMMENT_CREATE", "COMMENT_READ")));
    getCurrentUser.mockResolvedValue({ id: ACTOR_ID, displayName: "Ada", avatarUrl: null });

    // The Foreman console Approve button posts exactly this comment on this route.
    const res = await POST(postRequest("approve"), { params });
    expect(res.status).toBe(201);

    expect(publishToOrg).toHaveBeenCalledWith(ORG_ID, "work-item.updated", {
      id: ITEM_ID,
      projectId: PROJECT_ID,
      ticketNumber: 42,
    });
  });

  it("does not publish when the actor lacks COMMENT_CREATE (403, no write, no event)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("COMMENT_READ")));

    const res = await POST(postRequest(), { params });

    expect(res.status).toBe(403);
    expect(publishToOrg).not.toHaveBeenCalled();
  });
});

// COSMOS-191: "clicking a notification gives a 404". Every dashboard page lives
// under /[orgSlug], so a slug-less link resolves [orgSlug]="projects" and 404s.
// The assignee notification in this same handler always carried the slug; the
// mention notification twenty lines above it did not, so mention links — the
// ones users actually click — were dead in production for months.
//
// Assert the WHOLE url. A `toContain(org.slug)` here would pass against
// `/acme` alone and against a path with the segments in the wrong order.
describe("POST /work-items/[itemId]/comments — mention notification link (COSMOS-191)", () => {
  const MENTIONED_ID = "66666666-6666-6666-6666-666666666666";

  /** The route parses mentions out of the PERSISTED comment, not the request
   *  body, so the $transaction fixture is what has to carry the mention. */
  function persistedWithContent(content: string) {
    prisma.$transaction.mockResolvedValue([
      {
        id: "55555555-5555-5555-5555-555555555555",
        orgId: ORG_ID,
        workItemId: ITEM_ID,
        authorId: ACTOR_ID,
        content,
        createdAt: new Date("2026-07-10T00:00:00Z"),
        updatedAt: new Date("2026-07-10T00:00:00Z"),
      },
      { id: "activity-1" },
    ]);
  }

  it("links a mention notification to the org-scoped work-item route, not a slug-less 404", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("COMMENT_CREATE")));
    getCurrentUser.mockResolvedValue({ id: ACTOR_ID, displayName: "Dana" });
    prisma.orgMember.findMany.mockResolvedValue([{ userId: MENTIONED_ID }]);
    persistedWithContent(`Take a look <@${MENTIONED_ID}>`);

    const res = await POST(postRequest(`Take a look <@${MENTIONED_ID}>`), { params });
    expect(res.status).toBe(201);

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({
      userId: MENTIONED_ID,
      type: "comment.mentioned",
      url: `/acme/projects/ACME/work-items/${ITEM_ID}`,
    });
  });

  it("does not notify the author when they mention themselves", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("COMMENT_CREATE")));
    getCurrentUser.mockResolvedValue({ id: ACTOR_ID, displayName: "Dana" });
    prisma.orgMember.findMany.mockResolvedValue([{ userId: ACTOR_ID }]);
    persistedWithContent(`note to self <@${ACTOR_ID}>`);

    const res = await POST(postRequest(`note to self <@${ACTOR_ID}>`), { params });
    expect(res.status).toBe(201);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
