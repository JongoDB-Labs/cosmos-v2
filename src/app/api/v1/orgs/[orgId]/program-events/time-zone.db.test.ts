// @vitest-environment node
//
// A time zone is a value `Intl` can build. The routes took any string up to 100
// characters, and the calendar's chip formatted the stored value with `Intl`,
// which THROWS on a zone it does not know: one bad row took the calendar down
// for every viewer of it. The service now refuses the value, on create and on
// update, with a 400 that names it.
//
// Against a real database, through the real routes; only the caller is mocked.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/openapi/org-context", () => ({
  orgContext: vi.fn(async () => ({ org: { slug: "o" }, ctx: h.ctx })),
}));

import { POST } from "./route";
import { PATCH } from "./[eventId]/route";
import { createProgramEvent, listCategories } from "@/lib/program-calendar/service";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", userId = "", memberId = "", catId = "", eventId = "";

const BOGUS = "Mars/Olympus_Mons";
const body = (title: string, timeZone: string) => ({
  title, categoryId: catId, allDay: false, timeZone,
  startsAt: "2027-02-10T03:00:00.000Z", endsAt: "2027-02-10T04:00:00.000Z",
});
const post = (data: unknown) =>
  POST(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(data) }), {
    params: Promise.resolve({ orgId }),
  });
const patchEvent = (id: string, data: unknown) =>
  PATCH(new NextRequest("http://localhost/x", { method: "PATCH", body: JSON.stringify(data) }), {
    params: Promise.resolve({ orgId, eventId: id }),
  });
const patch = (data: unknown) => patchEvent(eventId, data);

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `pctz ${stamp}`, slug: `pctz-${stamp}` } })).id;
  userId = (await prisma.user.create({ data: { email: `pctz-${stamp}@pc.test`, displayName: "Planner" } })).id;
  memberId = (await prisma.orgMember.create({ data: { orgId, userId, role: "ADMIN", permissions: "0" } })).id;
  h.ctx = { userId, orgId, orgRole: "ADMIN", abacRules: [], permissions: -1n, basePermissions: -1n } satisfies AuthContext;
  catId = (await listCategories(orgId))[0].id;
  eventId = (await createProgramEvent(h.ctx as AuthContext, userId, {
    title: "Existing review", categoryId: catId, allDay: false, timeZone: "America/Los_Angeles",
    startsAt: new Date("2027-02-11T03:00:00.000Z"), endsAt: new Date("2027-02-11T04:00:00.000Z"),
  })).id;
});

afterAll(async () => {
  await prisma.programEvent.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.eventCategory.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

describe("a time zone Intl cannot build is refused, and the refusal names it", () => {
  it("on create: a 400 naming the value, and nothing stored", async () => {
    const res = await post(body("Bogus zone review", BOGUS));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(BOGUS);
    expect(await prisma.programEvent.count({ where: { orgId, title: "Bogus zone review" } })).toBe(0);
  });

  it("on update: a 400 naming the value, and the stored zone unchanged", async () => {
    const res = await patch(body("Existing review", BOGUS));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(BOGUS);
    const row = await prisma.programEvent.findUniqueOrThrow({ where: { id: eventId }, select: { timeZone: true } });
    expect(row.timeZone).toBe("America/Los_Angeles");
  });

  it("control: a real zone is taken, on create and on update", async () => {
    const created = await post(body("Kolkata review", "Asia/Kolkata"));
    expect(created.status).toBe(201);
    expect(await prisma.programEvent.count({ where: { orgId, title: "Kolkata review", timeZone: "Asia/Kolkata" } })).toBe(1);

    expect((await patch(body("Existing review", "Europe/Berlin"))).status).toBe(200);
    const row = await prisma.programEvent.findUniqueOrThrow({ where: { id: eventId }, select: { timeZone: true } });
    expect(row.timeZone).toBe("Europe/Berlin");
  });
});

describe("an update leaves alone what it does not send", () => {
  // PATCH wrote a default for every optional field it was not sent, so a
  // title change moved the event to New York, cleared its location, owner and
  // notes, and turned an all-day event into a timed one. Only create defaults.
  const FULL = {
    allDay: false, timeZone: "Asia/Kolkata", location: "Room 4", attendees: "Planning team",
    recurrence: "WEEKLY", customerAttending: true, description: "Agenda", showOnDashboard: true,
  } as const;
  const range = { startsAt: "2027-02-12T04:30:00.000Z", endsAt: "2027-02-12T05:30:00.000Z" };
  let id = "";
  const stored = () =>
    prisma.programEvent.findUniqueOrThrow({
      where: { id },
      select: {
        title: true, allDay: true, timeZone: true, location: true, attendees: true, recurrence: true,
        customerAttending: true, description: true, showOnDashboard: true, ownerMemberId: true,
      },
    });

  beforeAll(async () => {
    id = (await createProgramEvent(h.ctx as AuthContext, userId, {
      title: "Kolkata standup", categoryId: catId, ...FULL, ownerMemberId: memberId,
      startsAt: new Date(range.startsAt), endsAt: new Date(range.endsAt),
    })).id;
  });

  it("a title change keeps the zone, and every other field it did not send", async () => {
    const res = await patchEvent(id, { title: "Kolkata standup, renamed", categoryId: catId, allDay: false, ...range });
    expect(res.status).toBe(200);
    expect(await stored()).toEqual({ ...FULL, title: "Kolkata standup, renamed", ownerMemberId: memberId });
  });

  it("an all-day event stays all-day when the update does not say", async () => {
    const day = (await createProgramEvent(h.ctx as AuthContext, userId, {
      title: "Offsite", categoryId: catId, allDay: true,
      startsAt: new Date("2027-02-15T00:00:00.000Z"), endsAt: new Date("2027-02-15T00:00:00.000Z"),
    })).id;
    const res = await patchEvent(day, {
      title: "Offsite, moved", categoryId: catId,
      startsAt: "2027-02-16T00:00:00.000Z", endsAt: "2027-02-16T00:00:00.000Z",
    });
    expect(res.status).toBe(200);
    const row = await prisma.programEvent.findUniqueOrThrow({ where: { id: day }, select: { allDay: true, startsAt: true, endsAt: true } });
    expect(row).toEqual({
      allDay: true, startsAt: new Date("2027-02-16T00:00:00.000Z"), endsAt: new Date("2027-02-17T00:00:00.000Z"),
    });
  });

  it("control: what the update does send still changes, null included", async () => {
    const res = await patchEvent(id, {
      title: "Kolkata standup, renamed", categoryId: catId, ...range,
      allDay: false, timeZone: "Europe/Berlin", location: null, ownerMemberId: null, recurrence: "NONE",
    });
    expect(res.status).toBe(200);
    // Only what was sent: whether the rest stayed is the first test's question.
    expect(await stored()).toMatchObject({
      timeZone: "Europe/Berlin", location: null, ownerMemberId: null, recurrence: "NONE",
    });
  });
});
