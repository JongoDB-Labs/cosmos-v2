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

// COSMOS-191: "clicking a notification gives a 404".
//
// The first fix for this was WRONG and shipped: it added the missing /[orgSlug]
// prefix, on the theory that the slug was the problem. It is not — the
// notification dropdown normalises the prefix (strips a leading /{orgSlug} and
// re-adds exactly one), so both forms resolved identically. The real cause is
// that **there is no work-items route at all** — no
// /[orgSlug]/projects/[projectKey]/work-items/[id] page, and no catch-all — so
// every variant of that path 404s.
//
// The app's actual work-item deep link is /[orgSlug]/issues?item=<id>: 7 call
// sites use it, including issue-copy-link, and issues-view.tsx consumes it via
// searchParams.get("item").
//
// These tests therefore assert the URL's SHAPE (pathname + item param), not a
// string literal. A literal is what let the wrong fix look verified: the test
// asserted the URL I had decided on, so it passed while the bug stayed live.
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

  it("links a mention notification to a work-item route that EXISTS (/issues?item=)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("COMMENT_CREATE")));
    getCurrentUser.mockResolvedValue({ id: ACTOR_ID, displayName: "Dana" });
    prisma.orgMember.findMany.mockResolvedValue([
      // Shaped like the route's SELECT, which pulls the display name so the
      // notification body can name who was mentioned. A mock that returns only
      // `userId` made `m.user.displayName` throw INSIDE the route's
      // best-effort catch — so the notification silently never fired.
      { userId: MENTIONED_ID, user: { displayName: "Mentioned Person" } },
    ]);
    persistedWithContent(`Take a look <@${MENTIONED_ID}>`);

    const res = await POST(postRequest(`Take a look <@${MENTIONED_ID}>`), { params });
    expect(res.status).toBe(201);

    expect(createNotification).toHaveBeenCalledTimes(1);
    const call = createNotification.mock.calls[0][0];
    expect(call).toMatchObject({ userId: MENTIONED_ID, type: "comment.mentioned" });

    // Parse it the way the dropdown does, and check it names a route that exists.
    const u = new URL(call.url, "http://x");
    expect(u.pathname).toBe("/acme/issues");
    expect(u.searchParams.get("item")).toBe(ITEM_ID);
    // The dead route, in any form, must never come back.
    expect(call.url).not.toContain("work-items");
  });

  it("names the mentioned person in the body, and never shows a raw id", async () => {
    // The body used to be a hardcoded "@user", so it told the recipient someone
    // had been mentioned and never who — including when it was them.
    //
    // This assertion is what the suite was missing: the tests above check only
    // THAT a notification fired, so when the display-name lookup started
    // throwing inside the route's best-effort catch, "0 notifications" was the
    // only symptom and the cause was invisible.
    getAuthContext.mockResolvedValue(ctxWith(bits("COMMENT_CREATE")));
    prisma.orgMember.findMany.mockResolvedValue([
      { userId: MENTIONED_ID, user: { displayName: "Dana Scully" } },
    ]);
    persistedWithContent(`Take a look <@${MENTIONED_ID}>`);

    await POST(postRequest(`Take a look <@${MENTIONED_ID}>`), { params });

    const { message } = createNotification.mock.calls[0][0];
    expect(message).toBe("Take a look @Dana Scully");
    expect(message).not.toContain("@user");
    expect(message).not.toContain(MENTIONED_ID);
    expect(message).not.toContain("<@");
  });

  it("does not notify the author when they mention themselves", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("COMMENT_CREATE")));
    getCurrentUser.mockResolvedValue({ id: ACTOR_ID, displayName: "Dana" });
    prisma.orgMember.findMany.mockResolvedValue([
      { userId: ACTOR_ID, user: { displayName: "The Actor" } },
    ]);
    persistedWithContent(`note to self <@${ACTOR_ID}>`);

    const res = await POST(postRequest(`note to self <@${ACTOR_ID}>`), { params });
    expect(res.status).toBe(201);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
