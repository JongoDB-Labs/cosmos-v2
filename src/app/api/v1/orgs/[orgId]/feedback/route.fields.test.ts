// @vitest-environment node
//
// The list and update routes return per-viewer shapes, not raw rows: a plain
// member never receives another author's email, bug-report telemetry or the raw
// triage. Prisma is mocked so this runs without the e2e database.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";

const { prisma, getAuthContext, requireAccess } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    feedbackItem: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    feedbackVote: { findMany: vi.fn(), findFirst: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn() },
  },
  getAuthContext: vi.fn(),
  requireAccess: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/abac/require-access", () => ({ requireAccess }));
// Team-scope narrowing is covered against a real DB in
// lib/rbac/team-scope-feedback-expenses.db.test.ts; here nothing is hidden.
vi.mock("@/lib/rbac/project-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rbac/project-access")>()),
  hiddenProjectIds: async () => [],
  visibleProjectRecordsWhere: async () => ({}),
}));

import { GET } from "./route";
import { PUT, GET as GET_ONE } from "./[feedbackId]/route";

const ORG = "00000000-0000-4000-a000-000000000001";
const ME = "member-1";
const OTHER = "author-2";

const row = (authorId: string) => ({
  id: "f1",
  orgId: ORG,
  authorId,
  type: "BUG",
  title: "Crash",
  description: "",
  status: "OPEN",
  voteCount: 0,
  source: "app",
  sourceRef: null,
  deliveredAt: null,
  workItemId: null,
  projectId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  telemetry: { stack: "Error: boom" },
  triage: { guardrail: { decision: "hold", reason: "judge reasoning" } },
  attachments: [],
});

const asMember = () =>
  getAuthContext.mockResolvedValue({ userId: ME, orgId: ORG, permissions: Permission.ORG_READ });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "acme" });
  prisma.feedbackVote.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([{ id: OTHER, displayName: "Bo", email: "bo@example.com" }]);
  prisma.user.findUnique.mockResolvedValue({ displayName: "Me", email: "me@example.com" });
  requireAccess.mockResolvedValue(undefined);
});

describe("GET /feedback as a plain member", () => {
  it("returns no telemetry, raw triage or other authors' emails", async () => {
    asMember();
    prisma.feedbackItem.findMany.mockResolvedValue([row(OTHER)]);

    const res = await GET(new NextRequest(`http://x/api/v1/orgs/${ORG}/feedback`), {
      params: Promise.resolve({ orgId: ORG }),
    });
    const body = await res.json();
    const item = (body.data ?? body)[0];

    expect(item.title).toBe("Crash");
    expect(item.authorName).toBe("Bo");
    expect(item).not.toHaveProperty("telemetry");
    expect(item).not.toHaveProperty("triage");
    expect(item).not.toHaveProperty("authorEmail");
  });

  it("asks the database for named columns, not the whole row", async () => {
    asMember();
    prisma.feedbackItem.findMany.mockResolvedValue([]);

    await GET(new NextRequest(`http://x/api/v1/orgs/${ORG}/feedback`), {
      params: Promise.resolve({ orgId: ORG }),
    });

    const args = prisma.feedbackItem.findMany.mock.calls[0][0];
    expect(args).toHaveProperty("select");
    expect(args).not.toHaveProperty("include");
  });
});

describe("PUT /feedback/[id] as the author", () => {
  it("does not hand the triage reasoning back to an author editing their own item", async () => {
    asMember();
    prisma.feedbackItem.findFirst.mockResolvedValue(row(ME));
    prisma.feedbackItem.update.mockResolvedValue(row(ME));

    const res = await PUT(
      new NextRequest(`http://x/api/v1/orgs/${ORG}/feedback/f1`, {
        method: "PUT",
        body: JSON.stringify({ title: "Crash on save" }),
      }),
      { params: Promise.resolve({ orgId: ORG, feedbackId: "f1" }) },
    );
    const body = await res.json();
    const item = body.data ?? body;

    expect(res.status).toBe(200);
    expect(item).not.toHaveProperty("telemetry");
    expect(item).not.toHaveProperty("triage");
    expect(item.authorEmail).toBe("me@example.com");
  });
});

describe("GET /feedback/[id] (the ?item= deep link) as a plain member", () => {
  const getOne = () =>
    GET_ONE(new NextRequest(`http://x/api/v1/orgs/${ORG}/feedback/f1`), {
      params: Promise.resolve({ orgId: ORG, feedbackId: "f1" }),
    });

  it("returns the item in the same per-viewer shape as the list", async () => {
    asMember();
    prisma.feedbackItem.findFirst.mockResolvedValue(row(OTHER));
    prisma.feedbackVote.findFirst.mockResolvedValue({ feedbackItemId: "f1" });
    prisma.user.findUnique.mockResolvedValue({ displayName: "Bo", email: "bo@example.com" });

    const res = await getOne();
    const body = await res.json();
    const item = body.data ?? body;

    expect(res.status).toBe(200);
    expect(item).toMatchObject({ id: "f1", authorName: "Bo", hasVoted: true, attachments: [] });
    expect(item).not.toHaveProperty("telemetry");
    expect(item).not.toHaveProperty("triage");
    expect(item).not.toHaveProperty("authorEmail");
  });

  it("is a 404 for an item outside this org", async () => {
    asMember();
    prisma.feedbackItem.findFirst.mockResolvedValue(null);

    const res = await getOne();

    expect(res.status).toBe(404);
    expect(prisma.feedbackItem.findFirst.mock.calls[0][0].where).toEqual({ id: "f1", orgId: ORG });
  });
});
