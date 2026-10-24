// @vitest-environment node
//
// A work-item row carries `searchVector` (full-text index internals), which the
// WorkItem schema withholds. Outside production an undeclared field is a
// ResponseContractError, i.e. a 500, so the read queries must `omit` it; the
// first cut of PR3c-1 didn't and every list and detail read 500'd under
// `next dev`. Here Prisma hands back the column unless the query omits it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import { workItemRow } from "@/lib/openapi/testing/rows";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";

type Args = { omit?: { searchVector?: boolean } };
/** The whole row (searchVector included, as Prisma returns it) minus what `omit` drops. */
const row = (args: Args) => {
  const { searchVector, ...rest } = workItemRow({ id: ITEM, orgId: ORG, projectId: PROJECT });
  return {
    ...rest,
    ...(args.omit?.searchVector ? {} : { searchVector }),
    parent: null,
    children: [],
    workItemType: { id: ITEM, key: "software.task", name: "Task", icon: null, color: null },
    assignees: [],
  };
};
const detail = (args: Args) => ({ ...row(args), comments: [], activities: [], interval: null });

const h = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead: async () => {} }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: async () => ({ id: ORG, slug: "acme", settings: {} }) },
    project: { findFirst: async () => ({ id: PROJECT, orgId: ORG }) },
    workItem: {
      findMany: async (args: Args) => [row(args)],
      findFirst: async (args: Args) => detail(args),
    },
  },
}));

import { GET as listProjectItems } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route";
import { GET as getItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";

beforeEach(() => {
  h.getAuthContext.mockResolvedValue({
    userId: "u1", orgId: ORG, orgRole: OrgRole.MEMBER,
    permissions: Permission.ITEM_READ, basePermissions: Permission.ITEM_READ, abacRules: [],
  });
});

describe("work-item reads never return searchVector", () => {
  it("the project list answers 200 without it", async () => {
    const res = await listProjectItems(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId: ORG, projectId: PROJECT }) });
    expect(res.status).toBe(200);
    expect((await res.json())[0]).not.toHaveProperty("searchVector");
  });

  it("the detail answers 200 without it", async () => {
    const res = await getItem(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId: ORG, projectId: PROJECT, itemId: ITEM }) });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("searchVector");
  });
});
