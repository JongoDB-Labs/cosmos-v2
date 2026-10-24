// @vitest-environment node
//
// The daily Teams digest POSTS to the org's Teams channel, so it is a write.
// It was gated on ITEM_READ alone: any member, or any read key, could post it
// as often as they liked, with counts over projects they can't read. Now:
// INTEGRATION_MANAGE for a session, RULES_RUN plus ITEM_READ (rules:run + read, what
// .github/workflows/teams-digest.yml should use) for a key, one post per
// org per hour, and counts over the caller's readable projects.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const P1 = "a1111111-1111-4111-8111-111111111111";
const P2 = "a2222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  resolveAuth: vi.fn(),
  posted: [] as string[],
  counts: [] as unknown[],
  /** What the next Teams post does: succeed, fail, or throw. */
  outcome: "ok" as "ok" | "fail" | "throw",
}));
vi.mock("@/lib/auth/api-key", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/api-key")>()), resolveAuth: h.resolveAuth }));
vi.mock("@/lib/integrations/teams-notify", () => ({ teamsEventEnabled: async () => true }));
vi.mock("@/lib/integrations/teams", () => ({
  postTeamsChannelMessage: async (orgId: string) => {
    if (h.outcome === "throw") throw new Error("network down");
    if (h.outcome === "fail") return { ok: false, error: "Teams API error (HTTP 503) tenant detail" };
    h.posted.push(orgId);
    return { ok: true };
  },
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    // Postgres matches a uuid in any spelling and hands back the stored one.
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id.toLowerCase(), slug: "acme" }),
    },
    project: { findMany: async () => [{ id: P1, teamScopedAccess: false }, { id: P2, teamScopedAccess: false }] },
    workItem: { count: async (args: unknown) => { h.counts.push(args); return 1; } },
    feedbackItem: { count: async (args: unknown) => { h.counts.push(args); return 0; } },
  },
}));

import { POST } from "./route";

let n = 0;
/** A fresh org per call, so the per-org hourly limit never bleeds between cases. */
const freshOrg = () => `b${String(++n).padStart(7, "0")}-1111-4111-8111-111111111111`;
const post = (orgId: string) =>
  POST(new NextRequest("http://localhost/x", { method: "POST", body: "{}" }), { params: Promise.resolve({ orgId }) });
const as = (orgId: string, permissions: bigint, over: Partial<AuthContext> = {}): AuthContext => ({
  userId: "u1", orgId, orgRole: OrgRole.MEMBER, permissions, basePermissions: permissions, abacRules: [], ...over,
});
const READ = Permission.PROJECT_READ | Permission.ITEM_READ;

beforeEach(() => { vi.clearAllMocks(); h.posted.length = 0; h.counts.length = 0; h.outcome = "ok"; });

describe("who may post the digest", () => {
  it("a read key is refused, and nothing is posted", async () => {
    const org = freshOrg();
    h.resolveAuth.mockResolvedValue(as(org, READ, { isApiKey: true, scopes: ["read"] }));
    const res = await post(org);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/rules:run/);
    expect(h.posted).toEqual([]);
  });

  it("a rules:run + read key posts (the scheduled workflow)", async () => {
    const org = freshOrg();
    h.resolveAuth.mockResolvedValue(as(org, Permission.RULES_RUN | READ, { isApiKey: true, scopes: ["rules:run", "read"] }));
    expect((await post(org)).status).toBe(200);
    expect(h.posted).toEqual([org]);
  });

  it("a rules:run-only key is refused rather than posting zeros (it can read no project)", async () => {
    const org = freshOrg();
    h.resolveAuth.mockResolvedValue(as(org, Permission.RULES_RUN, { isApiKey: true, scopes: ["rules:run"] }));
    const res = await post(org);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/rules:run and read/);
    expect(h.posted).toEqual([]);
  });

  it("a member's session without INTEGRATION_MANAGE is refused", async () => {
    const org = freshOrg();
    h.resolveAuth.mockResolvedValue(as(org, READ));
    expect((await post(org)).status).toBe(403);
    expect(h.posted).toEqual([]);
  });

  it("an admin session with INTEGRATION_MANAGE posts", async () => {
    const org = freshOrg();
    h.resolveAuth.mockResolvedValue(as(org, READ | Permission.INTEGRATION_MANAGE, { orgRole: OrgRole.ADMIN }));
    expect((await post(org)).status).toBe(200);
  });
});

describe("one post per org per hour", () => {
  it("the second post in the hour is a 429, and isn't sent", async () => {
    const org = freshOrg();
    h.resolveAuth.mockResolvedValue(as(org, READ | Permission.INTEGRATION_MANAGE));
    expect((await post(org)).status).toBe(200);
    const again = await post(org);
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBeTruthy();
    expect(h.posted).toEqual([org]);
  });

  it("another spelling of the same org id shares the bucket", async () => {
    const org = freshOrg();
    h.resolveAuth.mockResolvedValue(as(org, READ | Permission.INTEGRATION_MANAGE));
    expect((await post(org)).status).toBe(200);
    expect((await post(org.toUpperCase())).status).toBe(429);
    expect(h.posted).toEqual([org]);
  });

  it("a failed post is a 502 that hides the detail, and doesn't use up the hour", async () => {
    const org = freshOrg();
    h.resolveAuth.mockResolvedValue(as(org, READ | Permission.INTEGRATION_MANAGE));
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.outcome = "fail";
    const failed = await post(org);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ posted: false, error: "teams_post_failed" });
    h.outcome = "ok";
    expect((await post(org)).status).toBe(200);
    expect(h.posted).toEqual([org]);
  });

  it("a post that throws doesn't use up the hour either", async () => {
    const org = freshOrg();
    h.resolveAuth.mockResolvedValue(as(org, READ | Permission.INTEGRATION_MANAGE));
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.outcome = "throw";
    expect((await post(org)).status).toBe(500);
    h.outcome = "ok";
    expect((await post(org)).status).toBe(200);
  });
});

describe("counts cover only readable projects", () => {
  it("a key limited to P1 counts P1's items only", async () => {
    const org = freshOrg();
    h.resolveAuth.mockResolvedValue(as(org, Permission.RULES_RUN | READ, { isApiKey: true, scopes: ["rules:run", "read"], projectScope: [P1] }));
    await post(org);
    const [completed, created, feedback] = h.counts as { where: Record<string, unknown> }[];
    expect(completed.where.projectId).toEqual({ in: [P1] });
    expect(created.where.projectId).toEqual({ in: [P1] });
    expect(feedback.where.OR).toEqual([{ projectId: null }, { projectId: { in: [P1] } }]);
  });
});
