// @vitest-environment node
//
// Mutating routes authenticate BEFORE they validate (ops' review of #1125): a
// caller who can't authenticate gets a 401, never a 400 whose `issues` describe
// what a valid request looks like. Path ids other than the org are validated
// after authentication too. Driven through the real handlers.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  findUnique: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma: { organization: { findUnique: h.findUnique } } }));

import { POST as createProject } from "@/app/api/v1/orgs/[orgId]/projects/route";
import { PUT as updateProject } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/route";
import { POST as createInterval } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/route";
import { PUT as updateInterval } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/route";
import { POST as createMilestone } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/milestones/route";
import { PATCH as updateMilestone } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/milestones/[milestoneId]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ROUTES: [string, Handler, string, Record<string, string>][] = [
  ["POST projects", createProject as Handler, "POST", { orgId: ORG }],
  ["PUT project", updateProject as Handler, "PUT", { orgId: ORG, projectId: ID }],
  ["POST intervals", createInterval as Handler, "POST", { orgId: ORG, projectId: ID }],
  ["PUT interval", updateInterval as Handler, "PUT", { orgId: ORG, projectId: ID, intervalId: ID }],
  ["POST milestones", createMilestone as Handler, "POST", { orgId: ORG, projectId: ID }],
  ["PATCH milestone", updateMilestone as Handler, "PATCH", { orgId: ORG, projectId: ID, milestoneId: ID }],
];

/** A body every one of these routes refuses: wrong types for their fields. */
const BAD = JSON.stringify({ name: 42, key: 7, title: 42, startDate: "soon", dueDate: "soon", settings: "x" });

const call = (handler: Handler, method: string, params: Record<string, string>) =>
  handler(
    new NextRequest(`http://localhost/api/v1/orgs/${params.orgId}/x`, {
      method, body: BAD, headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve(params) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.findUnique.mockResolvedValue({ id: ORG, slug: "acme" });
});

describe("mutating routes authenticate before they validate", () => {
  it.each(ROUTES)("%s: no credential and a bad body is a 401 that describes nothing", async (_n, handler, method, params) => {
    h.getAuthContext.mockResolvedValue(null);
    const res = await call(handler, method, params);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("unauthorized");
    expect(body).not.toHaveProperty("issues");
  });

  it.each(ROUTES)("%s: a non-UUID path id is a 400 only after authentication", async (_n, handler, method, params) => {
    const bad = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, k === "orgId" ? v : "nope"]));
    h.getAuthContext.mockResolvedValue(null);
    if (Object.keys(params).length > 1) expect((await call(handler, method, bad)).status).toBe(401);
  });

  it("a malformed org id is a 400 before any lookup (nothing to authenticate against)", async () => {
    const res = await call(createProject as Handler, "POST", { orgId: "nope" });
    expect(res.status).toBe(400);
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("%s: an authenticated caller with a bad body gets the 400 with issues", async (_n, handler, method, params) => {
    h.getAuthContext.mockResolvedValue({
      userId: "u1", orgId: ORG, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [],
    });
    const res = await call(handler, method, params);
    expect(res.status).toBe(400);
    expect((await res.json()).issues?.length).toBeGreaterThan(0);
  });
});
