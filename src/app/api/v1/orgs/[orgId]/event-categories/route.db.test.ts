// @vitest-environment node
//
// The category menu's counts are "what turning this category on would show",
// so they have to be counted over the same events the calendar is showing:
// the picked project (with or without the org's own events), the owner lanes
// and the custom filters. The route used to read only the window, so with a
// project picked every count stayed org-wide.
//
// Against a real database; only the caller is mocked.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/openapi/org-context", () => ({
  orgContext: vi.fn(async () => ({ org: { slug: "o" }, ctx: h.ctx })),
}));

import { GET } from "./route";
import { createProgramEvent, listCategories } from "@/lib/program-calendar/service";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", userId = "", memberId = "", p1 = "", p2 = "", catA = "", catB = "";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const WINDOW = "from=2027-03-01T00:00:00.000Z&to=2027-04-01T00:00:00.000Z";

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `pcc ${stamp}`, slug: `pcc-${stamp}` } })).id;
  userId = (await prisma.user.create({ data: { email: `pcc-${stamp}@pc.test`, displayName: "Planner" } })).id;
  memberId = (await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } })).id;
  const key = stamp.slice(0, 3).toUpperCase();
  p1 = (await prisma.project.create({ data: { orgId, name: "One", key: `CA${key}` } })).id;
  p2 = (await prisma.project.create({ data: { orgId, name: "Two", key: `CB${key}` } })).id;
  for (const projectId of [p1, p2]) {
    await prisma.projectMember.create({ data: { projectId, orgMemberId: memberId, role: "MEMBER" } });
  }
  h.ctx = { userId, orgId, orgRole: "MEMBER", abacRules: [], permissions: -1n, basePermissions: -1n } satisfies AuthContext;

  const cats = await listCategories(orgId);
  catA = cats[0].id;
  catB = cats[1].id;
  const ctx = h.ctx as AuthContext;
  const make = (title: string, d: number, over: Record<string, unknown>) =>
    createProgramEvent(ctx, userId, {
      title, categoryId: catA, startsAt: utc(2027, 3, d), endsAt: utc(2027, 3, d), allDay: true, ...over,
    });
  await make("Org-level review", 3, {});
  await make("Project one review", 4, { projectId: p1, showOnDashboard: true, customerAttending: true });
  await make("Project two review", 5, { projectId: p2, ownerMemberId: memberId });
});

afterAll(async () => {
  await prisma.programEvent.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.eventCategory.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

async function countFor(qs: string): Promise<number> {
  const res = await GET(new NextRequest(`http://localhost/x?${WINDOW}${qs ? `&${qs}` : ""}`), {
    params: Promise.resolve({ orgId }),
  });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as { id: string; count: number }[];
  return rows.find((r) => r.id === catA)!.count;
}

describe("category counts follow the calendar's filters", () => {
  it("control: with no filter, every event in the window counts", async () => {
    expect(await countFor("")).toBe(3);
  });

  it("a picked project with the org's events counts those two, not the other project", async () => {
    expect(await countFor(`projectId=${p1}&includeOrgEvents=true`)).toBe(2);
  });

  it("a picked project alone counts only its own", async () => {
    expect(await countFor(`projectId=${p1}`)).toBe(1);
  });

  it("the owner lanes and custom filters narrow the counts as they narrow the events", async () => {
    expect(await countFor(`ownerKeys=member:${memberId}`)).toBe(1);
    expect(await countFor("showOnDashboardOnly=true")).toBe(1);
    expect(await countFor("customerAttending=true")).toBe(1);
  });

  it("the category filter itself is still ignored, so a switched-off category shows its total", async () => {
    expect(await countFor(`categoryIds=${catB}`)).toBe(3);
  });

  it("refuses a filter value the events list would refuse", async () => {
    const res = await GET(new NextRequest(`http://localhost/x?${WINDOW}&includeOrgEvents=yes`), {
      params: Promise.resolve({ orgId }),
    });
    expect(res.status).toBe(400);
  });
});
