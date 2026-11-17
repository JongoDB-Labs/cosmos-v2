// @vitest-environment node
//
// Completing a sprint does not hand its cancelled duplicates to the next one
// (COSMOS-246), end to end through the Complete route.
//
// The unit tests beside this file pin the decision; this one pins the
// CONSEQUENCE, which is the thing the reporter actually saw: items cancelled as
// duplicates reappearing on the next sprint, and so on the next retrospective's
// "work to carry forward", for ever. The route both moves the items and records
// the carried set, so it is the only place the two can be checked together.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({
  getAuthContext: async () => h.ctx,
  getCurrentUser: async () => null,
}));

import { POST as completeInterval } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/complete/route";

const stamp = Math.random().toString(36).slice(2, 8);

let orgId = "", userId = "", projectId = "", typeId = "";

const tag = () => `${stamp}-${Math.random().toString(36).slice(2, 7)}`;

const sprint = (number: number, status: "ACTIVE" | "PLANNED") =>
  prisma.interval.create({
    data: {
      orgId, projectId, number, name: tag(), status, intervalKind: "SPRINT",
      startDate: new Date("2026-11-02"), endDate: new Date("2026-11-13"),
    },
  });

/** An item on `intervalId`, in `columnKey`, worth `storyPoints`. */
async function itemOn(intervalId: string, columnKey: string, storyPoints: number) {
  const created = await createFixtureWorkItem({
    orgId, projectId, workItemTypeId: typeId, createdById: userId, title: tag(), columnKey,
  });
  return prisma.workItem.update({
    where: { id: created.id },
    data: { intervalId, storyPoints },
  });
}

beforeAll(async () => {
  userId = (await prisma.user.create({
    data: { email: `cf-${stamp}@cf.test`, displayName: "cf" },
  })).id;
  orgId = (await prisma.organization.create({
    data: { name: `cf ${stamp}`, slug: `cf-${stamp}` },
  })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "OWNER", permissions: "0" } });
  projectId = (await prisma.project.create({
    data: { orgId, name: "Platform", key: `CF${stamp.slice(0, 4).toUpperCase()}` },
  })).id;
  // The default board's statuses, Cancelled included (COSMOS-206).
  await ensureFixtureStatuses(projectId);
  typeId = (await prisma.workItemType.findFirstOrThrow({
    where: { orgId: null, key: { endsWith: ".task" } },
  })).id;
});

afterAll(async () => {
  await prisma.workItem.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

describe("completing a sprint with cancelled duplicates", () => {
  it("rolls the open work into the next sprint and leaves the duplicates behind", async () => {
    h.ctx = {
      userId, orgId, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [],
    } satisfies AuthContext;

    const [active, next] = [await sprint(1, "ACTIVE"), await sprint(2, "PLANNED")];
    const delivered = await itemOn(active.id, "done", 5);
    const open = await itemOn(active.id, "todo", 3);
    // The reported case: cancelled by hand as a duplicate of another story,
    // with a completion date filled in. (A merge sets MERGED itself; a person
    // cancelling a duplicate they spotted picks a reason and types the note.)
    const dup = await itemOn(active.id, "cancelled", 8);
    await prisma.workItem.update({
      where: { id: dup.id },
      data: {
        cancelReason: "OTHER",
        cancelNote: "Duplicate from the PI planning spreadsheet",
        completedAt: new Date("2026-11-05"),
      },
    });

    const res = await completeInterval(
      new NextRequest("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ moveIncompleteToIntervalId: next.id }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ orgId, projectId, intervalId: active.id }) },
    );
    expect(res.status).toBe(200);

    const intervalOf = async (id: string) =>
      (await prisma.workItem.findUniqueOrThrow({ where: { id } })).intervalId;

    // THE ASSERTION. The duplicate stays on the sprint it was cancelled in; it
    // is not the next sprint's problem, nor its retrospective's.
    expect(await intervalOf(dup.id)).toBe(active.id);
    expect(await intervalOf(open.id)).toBe(next.id);
    // Delivered work has never moved, and still does not.
    expect(await intervalOf(delivered.id)).toBe(active.id);

    const report = (await prisma.interval.findUniqueOrThrow({
      where: { id: active.id },
    })).report as unknown as {
      carriedItemIds: string[];
      incompleteItems: number;
      completedItems: number;
      totalItems: number;
      totalStoryPoints: number;
      velocity: number;
    };
    // The recorded set is what the completed sprint's retrospective reads back
    // once the items belong to another sprint.
    expect(report.carriedItemIds).toEqual([open.id]);
    expect(report.incompleteItems).toBe(1);
    // The commitment is untouched: 16 points were committed before anyone knew
    // 8 of them were duplicated, and 5 were delivered.
    expect(report.totalItems).toBe(3);
    expect(report.totalStoryPoints).toBe(16);
    expect(report.completedItems).toBe(1);
    expect(report.velocity).toBe(5);
  });
});
