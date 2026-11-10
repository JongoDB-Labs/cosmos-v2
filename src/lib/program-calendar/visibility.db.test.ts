// @vitest-environment node
//
// Who sees which program-calendar events.
//
// The store is ORG-WIDE, which is right for the data and wrong as a default
// for reading: without an explicit rule, enabling the calendar would show
// every project's events to every member of the organization. So the default
// is the restrictive one — you see a project's events if you are on that
// project — and a project manager opts their project into org-wide visibility.
//
// Four audiences are exercised against the same data: a member of one project,
// a member of none, an org admin, and the owner of an opened project.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { listProgramEvents, visibleEvent, createProgramEvent, listCategories } from "./service";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "";
let alice = "", bob = "", admin = "";
let projA = "", projB = "", projOpen = "";
let evA = "", evB = "", evOpen = "", evOrgLevel = "";
let catId = "";

const member = (userId: string): AuthContext =>
  ({ userId, orgId, orgRole: "MEMBER", abacRules: [], permissions: -1n, basePermissions: -1n }) as AuthContext;
const orgAdmin = (userId: string): AuthContext =>
  ({ userId, orgId, orgRole: "ADMIN", abacRules: [], permissions: -1n, basePermissions: -1n }) as AuthContext;

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const WIN = [utc(2026, 11, 1), utc(2026, 12, 1)] as const;
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `vis ${stamp}`, slug: `vis-${stamp}` } })).id;

  const mk = async (name: string) => {
    const u = await prisma.user.create({ data: { email: `${name}-${stamp}@vis.test`, displayName: name } });
    return u.id;
  };
  alice = await mk("alice");
  bob = await mk("bob");
  admin = await mk("admin");

  const aliceM = await prisma.orgMember.create({ data: { orgId, userId: alice, role: "MEMBER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: bob, role: "MEMBER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: admin, role: "ADMIN", permissions: "0" } });

  const k = stamp.slice(0, 3).toUpperCase();
  // All three are ordinary, NON-team-scoped projects: this rule has to bite on
  // its own, not ride on `teamScopedAccess`.
  projA = (await prisma.project.create({ data: { orgId, name: "A", key: `VA${k}` } })).id;
  projB = (await prisma.project.create({ data: { orgId, name: "B", key: `VB${k}` } })).id;
  projOpen = (await prisma.project.create({
    data: { orgId, name: "Open", key: `VO${k}`, eventVisibility: "ORG" },
  })).id;

  // Alice is on A only.
  await prisma.projectMember.create({ data: { projectId: projA, orgMemberId: aliceM.id, role: "MEMBER" } });

  catId = (await listCategories(orgId))[0].id;

  const admCtx = orgAdmin(admin);
  const ev = async (title: string, projectId: string | null, day: number) =>
    (await createProgramEvent(admCtx, admin, {
      title, categoryId: catId, projectId,
      startsAt: utc(2026, 11, day), endsAt: utc(2026, 11, day), allDay: true,
    })).id;

  evA = await ev("A event", projA, 10);
  evB = await ev("B event", projB, 11);
  evOpen = await ev("Open event", projOpen, 12);
  evOrgLevel = await ev("Org-level event", null, 13);
});

afterAll(async () => {
  await prisma.programEvent.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.eventCategory.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [alice, bob, admin] } } }).catch(() => undefined);
});

describe("a member sees their own projects' events, and not other projects'", () => {
  it("Alice sees her project's events but NOT the project she is not on", async () => {
    const rows = await listProgramEvents(member(alice), ...WIN);
    expect(ids(rows)).toContain(evA);
    expect(ids(rows)).not.toContain(evB);
  });

  it("Bob, on no project at all, sees neither", async () => {
    const rows = await listProgramEvents(member(bob), ...WIN);
    expect(ids(rows)).not.toContain(evA);
    expect(ids(rows)).not.toContain(evB);
  });

  it("the default is PROJECT — a plain project is NOT org-visible", async () => {
    // The point of the whole change: these projects are not team-scoped, so
    // under the old rule every member would have seen both.
    const p = await prisma.project.findUniqueOrThrow({
      where: { id: projB },
      select: { eventVisibility: true, teamScopedAccess: true },
    });
    expect(p.eventVisibility).toBe("PROJECT");
    expect(p.teamScopedAccess).toBe(false);
  });
});

describe("a project opened to the org is visible to everyone", () => {
  it("both Alice and Bob see the opened project's events", async () => {
    for (const who of [alice, bob]) {
      const rows = await listProgramEvents(member(who), ...WIN);
      expect(ids(rows), who).toContain(evOpen);
    }
  });

  it("opening a project mid-flight reveals its events, and closing hides them again", async () => {
    // The live control: flip the flag and the same reader's answer changes,
    // which proves the rule reads the flag rather than something correlated
    // with it.
    expect(ids(await listProgramEvents(member(bob), ...WIN))).not.toContain(evB);
    await prisma.project.update({ where: { id: projB }, data: { eventVisibility: "ORG" } });
    expect(ids(await listProgramEvents(member(bob), ...WIN))).toContain(evB);
    await prisma.project.update({ where: { id: projB }, data: { eventVisibility: "PROJECT" } });
    expect(ids(await listProgramEvents(member(bob), ...WIN))).not.toContain(evB);
  });
});

describe("org-level events belong to everyone", () => {
  it("every member sees an event with no project", async () => {
    for (const who of [alice, bob]) {
      expect(ids(await listProgramEvents(member(who), ...WIN)), who).toContain(evOrgLevel);
    }
  });
});

describe("an org admin sees the whole programme", () => {
  it("sees every project's events", async () => {
    const rows = await listProgramEvents(orgAdmin(admin), ...WIN);
    for (const id of [evA, evB, evOpen, evOrgLevel]) expect(ids(rows)).toContain(id);
  });
});

describe("reading one event by id obeys the same rule", () => {
  it("refuses a project Alice is not on, allows the one she is", async () => {
    expect(await visibleEvent(member(alice), evB)).toBeNull();
    expect(await visibleEvent(member(alice), evA)).not.toBeNull();
  });

  it("allows the opened project and the org-level event to anyone", async () => {
    expect(await visibleEvent(member(bob), evOpen)).not.toBeNull();
    expect(await visibleEvent(member(bob), evOrgLevel)).not.toBeNull();
  });
});

describe("writing obeys the same rule as reading", () => {
  const attempt = (userId: string, projectId: string) =>
    createProgramEvent(member(userId), userId, {
      title: "Attempt", categoryId: catId, projectId,
      startsAt: utc(2026, 11, 25), endsAt: utc(2026, 11, 25), allDay: true,
    });

  it("refuses attaching an event to a project the writer cannot see", async () => {
    await expect(attempt(bob, projA)).rejects.toThrow();
  });

  it("allows their own project, and any project opened to the org", async () => {
    // The positive control: a check that refused everything would pass the
    // assertion above while making the feature unusable.
    await expect(attempt(alice, projA)).resolves.toBeTruthy();
    await expect(attempt(bob, projOpen)).resolves.toBeTruthy();
  });
});
