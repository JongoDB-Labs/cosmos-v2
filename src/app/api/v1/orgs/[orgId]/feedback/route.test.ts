// @vitest-environment node
//
// projectId on the feature-request create route (Task A7), against the REAL
// e2e DB (seeded `test-org` / `TEST` project — see DATABASE_URL in the e2e
// env). Only `getAuthContext` is mocked (session cookies aren't available in
// a route-handler test); `@/lib/db/client` is left unmocked so the org-scoped
// `prisma.project.findFirst` validation runs for real. Proves:
//   - a projectId belonging to THIS org's live projects persists onto the
//     created item;
//   - a projectId from another org, an archived project in this org, and a
//     bogus/nonexistent id are all rejected with 400 (no item created);
//   - omitting projectId entirely still succeeds, with projectId null.
// Every row a test creates is torn down in `afterAll` so a failed assertion
// never leaves the shared e2e DB dirty for the next run.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { GET, POST } from "./route";

const TITLE_PREFIX = "[A7-route-test]";
const OTHER_ORG_SLUG = "a7-route-test-other-org";
const OTHER_ORG_PROJECT_KEY = "A7OTHR";
const ARCHIVED_PROJECT_KEY = "A7ARCH";

let orgId: string;
let userId: string;
let testProjectId: string;
let otherOrgId: string;
let otherOrgProjectId: string;
let archivedProjectId: string;

function params() {
  return Promise.resolve({ orgId });
}

function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/feedback`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function get() {
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/feedback`);
}

async function purgeFixtures() {
  await prisma.feedbackItem.deleteMany({
    where: { orgId, title: { startsWith: TITLE_PREFIX } },
  });
  await prisma.project.deleteMany({
    where: { orgId, key: ARCHIVED_PROJECT_KEY },
  });
  const stale = await prisma.organization.findFirst({
    where: { slug: OTHER_ORG_SLUG },
    select: { id: true },
  });
  if (stale) {
    await prisma.project.deleteMany({ where: { orgId: stale.id } });
    await prisma.organization.delete({ where: { id: stale.id } });
  }
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({
    where: { slug: "test-org" },
    select: { id: true },
  });
  orgId = org.id;

  const project = await prisma.project.findFirstOrThrow({
    where: { orgId, key: "TEST" },
    select: { id: true },
  });
  testProjectId = project.id;

  const user = await prisma.user.findFirstOrThrow({
    where: { email: "alice@test.local" },
    select: { id: true },
  });
  userId = user.id;

  const ctx: AuthContext = {
    userId,
    orgId,
    orgRole: OrgRole.MEMBER,
    permissions: Permission.ORG_READ,
    basePermissions: Permission.ORG_READ,
    abacRules: [],
  };
  getAuthContext.mockResolvedValue(ctx);

  await purgeFixtures();

  const archived = await prisma.project.create({
    data: { orgId, key: ARCHIVED_PROJECT_KEY, name: "A7 route test — archived", archived: true },
    select: { id: true },
  });
  archivedProjectId = archived.id;

  const otherOrg = await prisma.organization.create({
    data: { name: "A7 route test — other org", slug: OTHER_ORG_SLUG },
    select: { id: true },
  });
  otherOrgId = otherOrg.id;

  const otherOrgProject = await prisma.project.create({
    data: { orgId: otherOrgId, key: OTHER_ORG_PROJECT_KEY, name: "A7 route test — other org project" },
    select: { id: true },
  });
  otherOrgProjectId = otherOrgProject.id;
});

afterAll(async () => {
  await prisma.feedbackItem.deleteMany({
    where: { orgId, title: { startsWith: TITLE_PREFIX } },
  });
  await prisma.project.delete({ where: { id: archivedProjectId } });
  await prisma.project.delete({ where: { id: otherOrgProjectId } });
  await prisma.organization.delete({ where: { id: otherOrgId } });
});

describe("POST /feedback — projectId (e2e)", () => {
  it("persists a projectId that belongs to this org's live projects", async () => {
    const res = await POST(
      post({
        type: "FEATURE",
        title: `${TITLE_PREFIX} valid project`,
        projectId: testProjectId,
      }),
      { params: params() },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.projectId).toBe(testProjectId);

    const row = await prisma.feedbackItem.findUniqueOrThrow({
      where: { id: json.id },
      select: { projectId: true },
    });
    expect(row.projectId).toBe(testProjectId);
  });

  it("leaves projectId null when omitted", async () => {
    const res = await POST(
      post({ type: "FEATURE", title: `${TITLE_PREFIX} no project` }),
      { params: params() },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.projectId).toBeNull();
  });

  it("leaves projectId null when explicitly null", async () => {
    const res = await POST(
      post({ type: "FEATURE", title: `${TITLE_PREFIX} explicit null`, projectId: null }),
      { params: params() },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.projectId).toBeNull();
  });

  it("400s on a projectId belonging to another org", async () => {
    const res = await POST(
      post({
        type: "FEATURE",
        title: `${TITLE_PREFIX} cross-org project`,
        projectId: otherOrgProjectId,
      }),
      { params: params() },
    );
    expect(res.status).toBe(400);

    const row = await prisma.feedbackItem.findFirst({
      where: { orgId, title: `${TITLE_PREFIX} cross-org project` },
    });
    expect(row).toBeNull();
  });

  it("400s on an archived project within this org", async () => {
    const res = await POST(
      post({
        type: "FEATURE",
        title: `${TITLE_PREFIX} archived project`,
        projectId: archivedProjectId,
      }),
      { params: params() },
    );
    expect(res.status).toBe(400);

    const row = await prisma.feedbackItem.findFirst({
      where: { orgId, title: `${TITLE_PREFIX} archived project` },
    });
    expect(row).toBeNull();
  });

  it("400s on a bogus/nonexistent projectId", async () => {
    const res = await POST(
      post({
        type: "FEATURE",
        title: `${TITLE_PREFIX} bogus project`,
        projectId: "00000000-0000-0000-0000-000000000000",
      }),
      { params: params() },
    );
    expect(res.status).toBe(400);

    const row = await prisma.feedbackItem.findFirst({
      where: { orgId, title: `${TITLE_PREFIX} bogus project` },
    });
    expect(row).toBeNull();
  });
});

describe("GET /feedback — submitter identity (e2e)", () => {
  it("includes the author's display name and email on each item", async () => {
    const created = await prisma.feedbackItem.create({
      data: {
        orgId,
        authorId: userId,
        type: "FEATURE",
        title: `${TITLE_PREFIX} author visibility`,
      },
      select: { id: true },
    });

    try {
      const res = await GET(get(), { params: params() });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        id: string;
        authorName: string | null;
        authorEmail: string | null;
      }[];

      const item = json.find((i) => i.id === created.id);
      expect(item).toBeDefined();
      expect(item!.authorName).toBe("Alice");
      expect(item!.authorEmail).toBe("alice@test.local");
    } finally {
      await prisma.feedbackItem.deleteMany({ where: { id: created.id } });
    }
  });
});
