// @vitest-environment node
//
// ⌘K and the @-mention typeahead matched names with Prisma's `contains`, which
// does NOT escape LIKE's wildcards: a search for "%" or "_" matched every
// title of every type the caller could read. Driven through the real routes
// against a real database, in an org of its own, so "every title" is a list
// this file wrote.
//
// Needs the local e2e DB: DATABASE_URL=postgresql://ci:ci@localhost:5441/<db>
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { createFixtureWorkItem } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
// The palette's limit has its own spec (search/route.test.ts); here it would only count requests.
vi.mock("@/lib/rate-limit/guard", () => ({ checkRateLimit: () => null }));

import { GET as globalSearch } from "@/app/api/v1/orgs/[orgId]/search/route";
import { GET as mentionSearch } from "@/app/api/v1/orgs/[orgId]/mentions/search/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "";
let userId = "";
const id: Record<string, string> = {};

const at = () => ({ params: Promise.resolve({ orgId }) });
function session(): AuthContext {
  const permissions = RolePermissions.ADMIN;
  return { userId, orgId, orgRole: "ADMIN", abacRules: [], basePermissions: permissions, permissions };
}

/** The ids ⌘K returns for `q`. */
async function palette(q: string): Promise<string[]> {
  h.ctx = session();
  const res = await globalSearch(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/search?q=${encodeURIComponent(q)}`), at());
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id).sort();
}

/** The ids the @-mention typeahead returns for `q`. */
async function mentions(q: string): Promise<string[]> {
  h.ctx = session();
  const res = await mentionSearch(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/mentions/search?q=${encodeURIComponent(q)}&perType=15`), at());
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id).sort();
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `wild ${stamp}`, slug: `wild-${stamp}` } })).id;
  userId = (await prisma.user.create({ data: { email: `searcher-${stamp}@wild.test`, displayName: `Searcher ${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "ADMIN", permissions: "0" } });
  const project = await prisma.project.create({ data: { orgId, name: `Wild project ${stamp}`, key: `W${stamp}`.toUpperCase().slice(0, 7) } });
  id.project = project.id;

  const typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
  const item = async (title: string) =>
    (await createFixtureWorkItem({ orgId, projectId: project.id, workItemTypeId: typeId, createdById: userId, title, columnKey: "todo" })).id;
  id.percent = await item("Rollout at 50% done");
  id.underscore = await item("Rename snake_case keys");
  id.backslash = await item("Fix the C:\\temp path");
  id.star = await item("Rate it five*");
  id.plainItem = await item("Plain work");
  // Other types, so "every title" spans more than work items.
  id.board = (await prisma.board.create({ data: { orgId, projectId: project.id, name: "Plain board", type: "KANBAN", sortOrder: 0 } })).id;
  id.risk = (await prisma.risk.create({ data: { orgId, projectId: project.id, code: "R-1", title: "Vendor slips" } })).id;
  id.contact = (await prisma.crmContact.create({ data: { orgId, name: "Dana Contact" } })).id;
  id.note = (await prisma.note.create({ data: { orgId, authorId: userId, title: "Standup notes", visibility: "ORG" } })).id;
});

afterAll(async () => {
  await prisma.note.deleteMany({ where: { orgId } });
  await prisma.crmContact.deleteMany({ where: { orgId } });
  await prisma.risk.deleteMany({ where: { orgId } });
  await prisma.board.deleteMany({ where: { orgId } });
  await prisma.workItem.deleteMany({ where: { orgId } });
  await prisma.workflowStatus.deleteMany({ where: { project: { orgId } } }).catch(() => {});
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("a LIKE wildcard in the search text is text", () => {
  it("control: an ordinary word matches across types, so the fixtures are searchable at all", async () => {
    expect(await palette("plain")).toEqual([id.plainItem, id.board].sort());
  });

  it('"%" matches only the title with a literal percent sign, not every title', async () => {
    expect(await palette("%")).toEqual([id.percent]);
  });

  it('"_" matches only the title with a literal underscore, not every title', async () => {
    expect(await palette("_")).toEqual([id.underscore]);
  });

  it('"\\" matches only the title with a literal backslash', async () => {
    expect(await palette("\\")).toEqual([id.backslash]);
  });

  it("a trailing * is text here too: the palette is not CQL, so it is no prefix", async () => {
    // likeText would strip it, leaving an empty search that matches everything.
    expect(await palette("*")).toEqual([id.star]);
  });

  it("the @-mention typeahead shares the rule", async () => {
    expect(await mentions("%")).toEqual([id.percent]);
    expect(await mentions("_")).toEqual([id.underscore]);
    expect(await mentions("plain")).toEqual([id.plainItem, id.board].sort());
  });
});
