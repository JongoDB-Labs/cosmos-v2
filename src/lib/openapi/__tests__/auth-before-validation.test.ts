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
import { POST as createGoal } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/goals/route";
import { PATCH as updateGoal } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/goals/[goalId]/route";
import { POST as createObjective, PATCH as reorderObjectives } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/route";
import { PUT as updateObjective } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/[objectiveId]/route";
import { POST as createKeyResult } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/[objectiveId]/key-results/route";
import { PUT as updateKeyResult } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/key-results/[krId]/route";
import { POST as createCheckin } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/key-results/[krId]/checkins/route";
import { POST as createKpi } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/kpis/route";
import { PATCH as updateKpi } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/kpis/[kpiId]/route";
import { POST as createDataPoint } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/kpis/[kpiId]/data-points/route";
import { POST as createTimeEntry } from "@/app/api/v1/orgs/[orgId]/time-entries/route";
import { PUT as updateTimeEntry } from "@/app/api/v1/orgs/[orgId]/time-entries/[entryId]/route";
import { POST as createStatus } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/statuses/route";
import { PATCH as updateStatus } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/statuses/[key]/route";
import { POST as createLink } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-item-links/route";
import { DELETE as deleteLink } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-item-links/[linkId]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ROUTES: [string, Handler, string, Record<string, string>][] = [
  ["POST projects", createProject as unknown as Handler, "POST", { orgId: ORG }],
  ["PUT project", updateProject as unknown as Handler, "PUT", { orgId: ORG, projectId: ID }],
  ["POST intervals", createInterval as unknown as Handler, "POST", { orgId: ORG, projectId: ID }],
  ["PUT interval", updateInterval as unknown as Handler, "PUT", { orgId: ORG, projectId: ID, intervalId: ID }],
  ["POST milestones", createMilestone as unknown as Handler, "POST", { orgId: ORG, projectId: ID }],
  ["PATCH milestone", updateMilestone as unknown as Handler, "PATCH", { orgId: ORG, projectId: ID, milestoneId: ID }],
  ["POST goals", createGoal as unknown as Handler, "POST", { orgId: ORG, projectId: ID }],
  ["PATCH goal", updateGoal as unknown as Handler, "PATCH", { orgId: ORG, projectId: ID, goalId: ID }],
  ["POST objectives", createObjective as unknown as Handler, "POST", { orgId: ORG, projectId: ID }],
  ["PATCH objectives (reorder)", reorderObjectives as unknown as Handler, "PATCH", { orgId: ORG, projectId: ID }],
  ["PUT objective", updateObjective as unknown as Handler, "PUT", { orgId: ORG, projectId: ID, objectiveId: ID }],
  ["POST key results", createKeyResult as unknown as Handler, "POST", { orgId: ORG, projectId: ID, objectiveId: ID }],
  ["PUT key result", updateKeyResult as unknown as Handler, "PUT", { orgId: ORG, projectId: ID, krId: ID }],
  ["POST check-ins", createCheckin as unknown as Handler, "POST", { orgId: ORG, projectId: ID, krId: ID }],
  ["POST kpis", createKpi as unknown as Handler, "POST", { orgId: ORG, projectId: ID }],
  ["PATCH kpi", updateKpi as unknown as Handler, "PATCH", { orgId: ORG, projectId: ID, kpiId: ID }],
  ["POST kpi data points", createDataPoint as unknown as Handler, "POST", { orgId: ORG, projectId: ID, kpiId: ID }],
  ["POST time entries", createTimeEntry as unknown as Handler, "POST", { orgId: ORG }],
  ["PUT time entry", updateTimeEntry as unknown as Handler, "PUT", { orgId: ORG, entryId: ID }],
  ["POST statuses", createStatus as unknown as Handler, "POST", { orgId: ORG, projectId: ID }],
  ["PATCH status", updateStatus as unknown as Handler, "PATCH", { orgId: ORG, projectId: ID, key: "todo" }],
  ["POST work-item links", createLink as unknown as Handler, "POST", { orgId: ORG, projectId: ID }],
];

/** A body every one of these routes refuses: an array where each expects an object. */
const BAD = JSON.stringify([{ name: 42, title: 42 }]);

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
    const res = await call(createProject as unknown as Handler, "POST", { orgId: "nope" });
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

describe("DELETE work-item link (no body) authenticates before it reads its path", () => {
  it("no credential and a bad link id is a 401 that describes nothing", async () => {
    h.getAuthContext.mockResolvedValue(null);
    const res = await (deleteLink as unknown as Handler)(
      new NextRequest(`http://localhost/api/v1/orgs/${ORG}/x`, { method: "DELETE" }),
      { params: Promise.resolve({ orgId: ORG, projectId: ID, linkId: "nope" }) },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("issues");
  });
});
