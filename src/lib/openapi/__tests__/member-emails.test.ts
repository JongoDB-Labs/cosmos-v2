// @vitest-environment node
//
// Member email addresses reach an API token only when it holds `members:read`
// (ops' decision on #1125): integrations match people by email, so removing
// them for every token silently breaks them, but handing a script everyone's
// address is something the key's owner opts into. Browser sessions always get
// them. Driven through the real GET handlers of both routes that carry them.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { projectRow } from "@/lib/openapi/testing/rows";

const h = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  orgMember: { findMany: vi.fn() },
  project: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db/client", () => ({ prisma: { orgMember: h.orgMember, project: h.project } }));
vi.mock("@/lib/openapi/org-context", () => ({ orgContext: vi.fn(async () => ({ org: {}, ctx: h.ctx })) }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead: vi.fn(async () => undefined) }));

import { GET as listMembers } from "@/app/api/v1/orgs/[orgId]/members/route";
import { GET as getProject } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const EMAIL = "pat@agency.gov";
const user = { id: USER, email: EMAIL, displayName: "Pat", avatarUrl: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.orgMember.findMany.mockResolvedValue([
    { id: MEMBER, orgId: ORG, userId: USER, role: "MEMBER", joinedAt: new Date("2026-01-01T00:00:00Z"), user: { ...user, lastActiveAt: null } },
  ]);
  h.project.findFirst.mockResolvedValue({
    ...projectRow({ id: PROJECT, orgId: ORG, settings: { email: "alerts@agency.gov" } }),
    boards: [], intervals: [],
    members: [{
      id: "55555555-5555-4555-8555-555555555555", projectId: PROJECT, orgMemberId: MEMBER, role: "MEMBER",
      allocationPercent: null, onContract: false, cacStatus: null, cacExpiry: null, trainingStatus: null,
      accessStatus: null, ndaStatus: null, complianceNotes: null,
      orgMember: { id: MEMBER, role: "MEMBER", user },
    }],
  });
});

async function emails(ctx: Record<string, unknown>) {
  h.ctx = ctx;
  const members = await listMembers(new NextRequest(`http://localhost/api/v1/orgs/${ORG}/members`), {
    params: Promise.resolve({ orgId: ORG }),
  });
  const project = await getProject(new NextRequest(`http://localhost/api/v1/orgs/${ORG}/projects/${PROJECT}`), {
    params: Promise.resolve({ orgId: ORG, projectId: PROJECT }),
  });
  expect(members.status).toBe(200);
  expect(project.status).toBe(200);
  const m = await members.json();
  const p = await project.json();
  return { list: m[0].user.email, detail: p.members[0].orgMember.user.email, settings: p.settings.email };
}

describe("member emails and members:read", () => {
  it("a browser session gets them", async () => {
    expect(await emails({ userId: USER })).toEqual({ list: EMAIL, detail: EMAIL, settings: "alerts@agency.gov" });
  });

  it("a token holding members:read gets them", async () => {
    expect(await emails({ userId: USER, isApiKey: true, scopes: ["read", "members:read"] }))
      .toEqual({ list: EMAIL, detail: EMAIL, settings: "alerts@agency.gov" });
  });

  it("a token without it gets neither, and the project's own settings are untouched", async () => {
    expect(await emails({ userId: USER, isApiKey: true, scopes: ["read"] }))
      .toEqual({ list: undefined, detail: undefined, settings: "alerts@agency.gov" });
  });
});
