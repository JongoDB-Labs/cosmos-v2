// @vitest-environment node
//
// The two rules most likely to be wrong, against a real database:
//
//  1. A multi-day event appears in every window it CROSSES. The naive
//     `startsAt BETWEEN from AND to` loses an event that began last month
//     and is still running — exactly the events a program calendar exists for.
//  2. An event hanging off a team-scoped project is that team's. The same rule
//     that governs invoices, expenses and bills; bills had it in one place and
//     missing in three, so it is asserted here on BOTH the list and the
//     by-id read.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import {
  listProgramEvents,
  visibleEvent,
  createProgramEvent,
  categoryCounts,
  listCategories,
  ownerKeyOf,
  ownerLabelOf,
} from "./service";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", insider = "", outsider = "", restricted = "", openProj = "";
let catA = "", catB = "", teamId = "", insiderMemberId = "";
let evOrg = "", evOpen = "", evRestricted = "", evSpanning = "";

const ctxFor = (userId: string): AuthContext =>
  ({ userId, orgId, orgRole: "MEMBER", abacRules: [], permissions: -1n, basePermissions: -1n }) as AuthContext;

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `pc ${stamp}`, slug: `pc-${stamp}` } })).id;
  insider = (await prisma.user.create({ data: { email: `in-${stamp}@pc.test`, displayName: "Insider" } })).id;
  outsider = (await prisma.user.create({ data: { email: `out-${stamp}@pc.test`, displayName: "Outsider" } })).id;
  const im = await prisma.orgMember.create({ data: { orgId, userId: insider, role: "MEMBER", permissions: "0" } });
  insiderMemberId = im.id;
  await prisma.orgMember.create({ data: { orgId, userId: outsider, role: "MEMBER", permissions: "0" } });

  const key = stamp.slice(0, 3).toUpperCase();
  restricted = (await prisma.project.create({
    data: { orgId, name: "Restricted", key: `PR${key}`, teamScopedAccess: true },
  })).id;
  // Opened to the whole org: this fixture's "open" project means one every
  // member can see, and since the calendar's default is now PROJECT-only that
  // has to be said explicitly rather than assumed from the absence of
  // teamScopedAccess.
  openProj = (await prisma.project.create({
    data: { orgId, name: "Open", key: `PO${key}`, eventVisibility: "ORG" },
  })).id;
  await prisma.projectMember.create({ data: { projectId: restricted, orgMemberId: im.id, role: "MEMBER" } });

  teamId = (await prisma.team.create({ data: { orgId, projectId: openProj, name: `PM Team ${stamp}` } })).id;

  const cats = await listCategories(orgId);
  catA = cats[0].id;
  catB = cats[1].id;

  const ctx = ctxFor(insider);
  evOrg = (await createProgramEvent(ctx, insider, {
    title: "Org-wide review", categoryId: catA,
    startsAt: utc(2026, 11, 12), endsAt: utc(2026, 11, 12), allDay: true,
  })).id;
  evOpen = (await createProgramEvent(ctx, insider, {
    title: "Open project review", categoryId: catA, projectId: openProj,
    startsAt: utc(2026, 11, 13), endsAt: utc(2026, 11, 13), allDay: true,
  })).id;
  evRestricted = (await createProgramEvent(ctx, insider, {
    title: "Restricted event", categoryId: catB, projectId: restricted,
    startsAt: utc(2026, 11, 14), endsAt: utc(2026, 11, 14), allDay: true,
  })).id;
  // Begins in October, still running in December — crosses November entirely.
  evSpanning = (await createProgramEvent(ctx, insider, {
    title: "Long running event", categoryId: catA,
    startsAt: utc(2026, 10, 20), endsAt: utc(2026, 12, 5), allDay: true,
    ownerTeamId: teamId,
  })).id;
});

afterAll(async () => {
  await prisma.programEvent.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.eventCategory.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [insider, outsider] } } }).catch(() => undefined);
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("a multi-day event appears in every window it crosses", () => {
  it("is listed for a November window although it starts in October and ends in December", async () => {
    const rows = await listProgramEvents(ctxFor(insider), utc(2026, 11, 1), utc(2026, 12, 1));
    expect(ids(rows)).toContain(evSpanning);
  });

  it("is listed for the October window and the December window too", async () => {
    const oct = await listProgramEvents(ctxFor(insider), utc(2026, 10, 1), utc(2026, 11, 1));
    const dec = await listProgramEvents(ctxFor(insider), utc(2026, 12, 1), utc(2027, 1, 1));
    expect(ids(oct)).toContain(evSpanning);
    expect(ids(dec)).toContain(evSpanning);
  });

  it("is NOT listed for a window it misses entirely", async () => {
    // The positive control: without this the overlap test could be returning
    // everything and all three assertions above would still pass.
    const jun = await listProgramEvents(ctxFor(insider), utc(2026, 6, 1), utc(2026, 7, 1));
    expect(ids(jun)).not.toContain(evSpanning);
    expect(ids(jun)).toHaveLength(0);
  });

  it("excludes an event that ends exactly as the window opens", async () => {
    // evOrg covers 12 Nov only, so a window starting 13 Nov must not hold it.
    const rows = await listProgramEvents(ctxFor(insider), utc(2026, 11, 13), utc(2026, 11, 20));
    expect(ids(rows)).not.toContain(evOrg);
  });
});

describe("an event on a team-scoped project is that team's", () => {
  it("the list hides it from an outsider, keeping org-level and open ones", async () => {
    const rows = await listProgramEvents(ctxFor(outsider), utc(2026, 11, 1), utc(2026, 12, 1));
    expect(ids(rows)).not.toContain(evRestricted);
    // Positive controls: this is visibility, not an empty list.
    expect(ids(rows)).toContain(evOrg);
    expect(ids(rows)).toContain(evOpen);
  });

  it("the team's own member still sees it", async () => {
    const rows = await listProgramEvents(ctxFor(insider), utc(2026, 11, 1), utc(2026, 12, 1));
    expect(ids(rows)).toContain(evRestricted);
  });

  it("reading it by id is refused for an outsider and allowed for the member", async () => {
    // The by-id path is where the equivalent bills guard was missing while the
    // list was already correct.
    expect(await visibleEvent(ctxFor(outsider), evRestricted)).toBeNull();
    expect(await visibleEvent(ctxFor(insider), evRestricted)).not.toBeNull();
  });

  it("an outsider can still read an org-level event by id", async () => {
    expect(await visibleEvent(ctxFor(outsider), evOrg)).not.toBeNull();
  });
});

describe("category counts follow the same scope", () => {
  it("counts what the reader can see, and not what they cannot", async () => {
    const mine = await categoryCounts(ctxFor(insider), utc(2026, 11, 1), utc(2026, 12, 1));
    const theirs = await categoryCounts(ctxFor(outsider), utc(2026, 11, 1), utc(2026, 12, 1));
    expect(mine[catB] ?? 0).toBe(1);
    expect(theirs[catB] ?? 0).toBe(0);
  });

  it("ignores the category filter so a hidden category still shows its total", async () => {
    const counts = await categoryCounts(ctxFor(insider), utc(2026, 11, 1), utc(2026, 12, 1), {
      categoryIds: [catA],
    });
    expect(counts[catB] ?? 0).toBe(1);
  });
});

describe("an event cannot reference something outside the org, or hidden", () => {
  // Found by review, not by me. `ownerTeam` and `deliverable` are selected
  // back and RENDERED, so an id borrowed from another tenant would print that
  // tenant's team or deliverable name into this org's calendar.
  let foreignOrg = "", foreignTeam = "", foreignProject = "";

  beforeAll(async () => {
    foreignOrg = (await prisma.organization.create({
      data: { name: `other ${stamp}`, slug: `other-${stamp}` },
    })).id;
    foreignProject = (await prisma.project.create({
      data: { orgId: foreignOrg, name: "Theirs", key: `XX${stamp.slice(0, 3).toUpperCase()}` },
    })).id;
    foreignTeam = (await prisma.team.create({
      data: { orgId: foreignOrg, projectId: foreignProject, name: "Their Team" },
    })).id;
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: foreignOrg } }).catch(() => undefined);
  });

  const attempt = (over: Record<string, unknown>) =>
    createProgramEvent(ctxFor(insider), insider, {
      title: "Attempt", categoryId: catA,
      startsAt: utc(2026, 11, 21), endsAt: utc(2026, 11, 21), allDay: true,
      ...over,
    } as Parameters<typeof createProgramEvent>[2]);

  it("refuses another org's team as the owner", async () => {
    await expect(attempt({ ownerTeamId: foreignTeam })).rejects.toThrow();
  });

  it("refuses another org's project", async () => {
    await expect(attempt({ projectId: foreignProject })).rejects.toThrow();
  });

  it("refuses another org's category", async () => {
    const theirCat = await prisma.eventCategory.create({
      data: { orgId: foreignOrg, name: "Theirs", tintRgb: "1 2 3", textColor: "#000000" },
    });
    await expect(attempt({ categoryId: theirCat.id })).rejects.toThrow();
  });

  it("refuses a project in THIS org that the caller cannot see", async () => {
    // Not a cross-tenant case: an org member attaching an event to a
    // team-scoped project they are not on.
    await expect(
      createProgramEvent(ctxFor(outsider), outsider, {
        title: "Attempt", categoryId: catA,
        startsAt: utc(2026, 11, 21), endsAt: utc(2026, 11, 21), allDay: true,
        projectId: restricted,
      }),
    ).rejects.toThrow();
  });

  it("refuses a team in THIS org whose project the caller cannot see", async () => {
    // The fixture's main team sits on a VISIBLE project, so it could never
    // have caught this: a team belongs to a project, and the team's name is
    // the lane label, so a team on a team-scoped project would have leaked
    // its name to an outsider.
    const hiddenTeam = await prisma.team.create({
      data: { orgId, projectId: restricted, name: `Restricted Team ${stamp}` },
    });
    await expect(
      createProgramEvent(ctxFor(outsider), outsider, {
        title: "Attempt", categoryId: catA,
        startsAt: utc(2026, 11, 22), endsAt: utc(2026, 11, 22), allDay: true,
        ownerTeamId: hiddenTeam.id,
      }),
    ).rejects.toThrow();

    // And the team's own member may still use it — visibility, not a blanket ban.
    const ok = await createProgramEvent(ctxFor(insider), insider, {
      title: "Allowed", categoryId: catA,
      startsAt: utc(2027, 4, 22), endsAt: utc(2027, 4, 22), allDay: true,
      ownerTeamId: hiddenTeam.id,
    });
    expect(ok.id).toBeTruthy();
  });

  it("still allows the ids that ARE in the org and visible", async () => {
    // The positive control: without it, a check that rejected everything would
    // pass all four assertions above.
    // Deliberately OUTSIDE the November window the other specs query: this
    // event owns the same team lane, and adding it to that window would change
    // what the owner-filter spec sees.
    const ok = await createProgramEvent(ctxFor(insider), insider, {
      title: "Legitimate", categoryId: catA,
      startsAt: utc(2027, 3, 21), endsAt: utc(2027, 3, 21), allDay: true,
      projectId: openProj, ownerTeamId: teamId,
    });
    expect(ok.id).toBeTruthy();
  });
});

describe("owner lanes", () => {
  it("groups by team when there is one", async () => {
    const rows = await listProgramEvents(ctxFor(insider), utc(2026, 11, 1), utc(2026, 12, 1));
    const spanning = rows.find((r) => r.id === evSpanning)!;
    expect(ownerKeyOf(spanning)).toBe(`team:${teamId}`);
    expect(ownerLabelOf(spanning)).toContain("PM Team");
  });

  it("falls back to Unassigned when neither owner is set", async () => {
    const rows = await listProgramEvents(ctxFor(insider), utc(2026, 11, 1), utc(2026, 12, 1));
    const org = rows.find((r) => r.id === evOrg)!;
    expect(ownerKeyOf(org)).toBe("unassigned");
    expect(ownerLabelOf(org)).toBe("Unassigned");
  });

  it("an owner filter narrows to that lane, and unassigned excludes a person's", async () => {
    const byTeam = await listProgramEvents(ctxFor(insider), utc(2026, 11, 1), utc(2026, 12, 1), {
      ownerKeys: [`team:${teamId}`],
    });
    expect(ids(byTeam)).toEqual([evSpanning]);

    const owned = await createProgramEvent(ctxFor(insider), insider, {
      title: "Personally owned", categoryId: catA,
      startsAt: utc(2026, 11, 18), endsAt: utc(2026, 11, 18), allDay: true,
      ownerMemberId: insiderMemberId,
    });
    const unassigned = await listProgramEvents(ctxFor(insider), utc(2026, 11, 1), utc(2026, 12, 1), {
      ownerKeys: ["unassigned"],
    });
    // An event owned by a PERSON has a null team; "unassigned" must not sweep
    // it up on that basis alone.
    expect(ids(unassigned)).not.toContain(owned.id);
    expect(ids(unassigned)).toContain(evOrg);
  });
});
