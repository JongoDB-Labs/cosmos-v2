// @vitest-environment node
//
// projectId derivation (Task A6) for the auto bug-report route, against the
// REAL e2e DB (seeded `test-org` / `TEST` project — see DATABASE_URL in the
// e2e env). Only `getAuthContext` is mocked (session cookies aren't available
// in a route-handler test); `@/lib/db/client` is left unmocked so
// `projectKeyFromRoute` + the org-scoped `tx.project.findFirst` lookup run
// for real. Proves:
//   - a route matching a live project in THIS org tags the new item with it;
//   - a route whose key matches no project resolves to a null projectId
//     (app-level, not an error);
//   - no route at all also resolves to a null projectId.
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
import { POST } from "./route";

const TITLE_PREFIX = "[Bug] [A6-route-test]";

let orgId: string;
let userId: string;
let testProjectId: string;

function params() {
  return Promise.resolve({ orgId });
}

function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/feedback/report-bug`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function purgeFixtures() {
  await prisma.feedbackItem.deleteMany({
    where: { orgId, type: "BUG", title: { startsWith: TITLE_PREFIX } },
  });
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
});

afterAll(async () => {
  await purgeFixtures();
});

describe("report-bug — projectId derivation from route (e2e)", () => {
  it("tags the created item with the project whose key matches the route, scoped to this org", async () => {
    const res = await POST(
      post({
        message: "[A6-route-test] message A — route matches project",
        route: "/test-org/projects/TEST/x",
      }),
      { params: params() },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deduped).toBe(false);

    const row = await prisma.feedbackItem.findUniqueOrThrow({
      where: { id: json.id },
      select: { projectId: true, authorId: true },
    });
    expect(row.projectId).toBe(testProjectId);
    expect(row.authorId).toBe(userId);
  });

  it("leaves projectId null when the route's key matches no project in this org", async () => {
    const res = await POST(
      post({
        message: "[A6-route-test] message B — route matches no project",
        route: "/test-org/projects/NOPE/x",
      }),
      { params: params() },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deduped).toBe(false);

    const row = await prisma.feedbackItem.findUniqueOrThrow({
      where: { id: json.id },
      select: { projectId: true },
    });
    expect(row.projectId).toBeNull();
  });

  it("leaves projectId null when the report carries no route at all", async () => {
    const res = await POST(
      post({ message: "[A6-route-test] message C — no route provided" }),
      { params: params() },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deduped).toBe(false);

    const row = await prisma.feedbackItem.findUniqueOrThrow({
      where: { id: json.id },
      select: { projectId: true },
    });
    expect(row.projectId).toBeNull();
  });
});
