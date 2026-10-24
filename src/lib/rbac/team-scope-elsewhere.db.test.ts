// @vitest-environment node
//
// The team-scope rule outside the projects/[projectId] tree. Meetings, time
// entries, contracts and custom fields can each belong to a project, and their
// reads already hid a team-scoped project's records from people outside its
// team, but their writes didn't ask. Now a write by id answers a hidden record
// with the same 404 as a missing one, and naming a hidden project is a 403.
// Through the real routes, against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as createMeeting } from "@/app/api/v1/orgs/[orgId]/meetings/route";
import { PUT as updateMeeting, DELETE as deleteMeeting } from "@/app/api/v1/orgs/[orgId]/meetings/[meetingId]/route";
import { POST as createEntry } from "@/app/api/v1/orgs/[orgId]/time-entries/route";
import { PUT as updateEntry, DELETE as deleteEntry } from "@/app/api/v1/orgs/[orgId]/time-entries/[entryId]/route";
import { PUT as updateContract, DELETE as deleteContract } from "@/app/api/v1/orgs/[orgId]/contracts/[contractId]/route";
import { POST as createField } from "@/app/api/v1/orgs/[orgId]/custom-fields/route";
import { PUT as updateField, DELETE as deleteField } from "@/app/api/v1/orgs/[orgId]/custom-fields/[fieldId]/route";
import { POST as addAttendee } from "@/app/api/v1/orgs/[orgId]/meetings/[meetingId]/attendees/route";
import { DELETE as removeAttendee } from "@/app/api/v1/orgs/[orgId]/meetings/[meetingId]/attendees/[attendeeId]/route";
import { POST as bindField } from "@/app/api/v1/orgs/[orgId]/work-item-types/[typeId]/fields/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", restricted = "", open = "", outsider = "", insider = "";

beforeAll(async () => {
  outsider = (await prisma.user.create({ data: { email: `out-${stamp}@tse.test`, displayName: "Outsider" } })).id;
  insider = (await prisma.user.create({ data: { email: `in-${stamp}@tse.test`, displayName: "Insider" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `tse ${stamp}`, slug: `tse-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: outsider, role: "MEMBER", permissions: "0" } });
  const insiderMembership = await prisma.orgMember.create({ data: { orgId, userId: insider, role: "MEMBER", permissions: "0" } });
  const key = stamp.slice(0, 3).toUpperCase();
  restricted = (await prisma.project.create({ data: { orgId, name: "R", key: `ER${key}`, teamScopedAccess: true } })).id;
  open = (await prisma.project.create({ data: { orgId, name: "O", key: `EO${key}` } })).id;
  await prisma.projectMember.create({ data: { projectId: restricted, orgMemberId: insiderMembership.id, role: "MEMBER" } });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [outsider, insider] } } }).catch(() => undefined);
});

/** A member whose roles grant every bit: only visibility can refuse them. */
const member = (userId: string): AuthContext => ({ userId, orgId, orgRole: "MEMBER", abacRules: [], permissions: -1n, basePermissions: -1n });
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const at = <T extends Record<string, string>>(extra: T) => ({ params: Promise.resolve({ orgId, ...extra }) });

describe("meetings", () => {
  const meetingIn = async (projectId: string | null) =>
    (await prisma.syncMeeting.create({ data: { orgId, projectId, title: "standup", meetingDate: new Date(), createdById: insider } })).id;

  it("an outsider can't file one under the project, nor change or delete one filed there", async () => {
    h.ctx = member(outsider);
    expect((await createMeeting(req("POST", { title: "m", projectId: restricted, meetingDate: "2026-11-01T10:00:00.000Z" }), at({}))).status).toBe(403);
    const id = await meetingIn(restricted);
    expect((await updateMeeting(req("PUT", { title: "renamed" }), at({ meetingId: id }))).status).toBe(404);
    expect((await deleteMeeting(req("DELETE"), at({ meetingId: id }))).status).toBe(404);
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id } })).title).toBe("standup");
  });

  it("the team can; and a meeting under no project is anyone's to edit, as before", async () => {
    h.ctx = member(insider);
    expect((await updateMeeting(req("PUT", { title: "renamed" }), at({ meetingId: await meetingIn(restricted) }))).status).toBe(200);
    h.ctx = member(outsider);
    expect((await updateMeeting(req("PUT", { title: "renamed" }), at({ meetingId: await meetingIn(null) }))).status).toBe(200);
  });
});

describe("time entries", () => {
  const entryIn = async (projectId: string | null, userId: string) =>
    (await prisma.timeEntry.create({ data: { orgId, userId, projectId, date: new Date("2026-10-20"), hours: 1 } })).id;

  it("an outsider can't log time against the project, move an entry into it, or touch one there", async () => {
    h.ctx = member(outsider);
    expect((await createEntry(req("POST", { date: "2026-10-20", hours: 1, projectId: restricted }), at({}))).status).toBe(403);
    const mine = await entryIn(open, outsider);
    expect((await updateEntry(req("PUT", { projectId: restricted }), at({ entryId: mine }))).status).toBe(403);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: mine } })).projectId).toBe(open);
    const there = await entryIn(restricted, outsider);
    expect((await updateEntry(req("PUT", { hours: 2 }), at({ entryId: there }))).status).toBe(404);
    expect((await deleteEntry(req("DELETE", { reason: "mistake" }), at({ entryId: there }))).status).toBe(404);
  });

  it("the team logs time there as before", async () => {
    h.ctx = member(insider);
    expect((await createEntry(req("POST", { date: "2026-10-20", hours: 1, projectId: restricted }), at({}))).status).toBe(201);
  });
});

describe("contracts", () => {
  it("an outsider can't change or delete a contract of the project; the team can", async () => {
    const id = (await prisma.contract.create({ data: { orgId, projectId: restricted, title: "MSA" } })).id;
    h.ctx = member(outsider);
    expect((await updateContract(req("PUT", { title: "x" }), at({ contractId: id }))).status).toBe(404);
    expect((await deleteContract(req("DELETE"), at({ contractId: id }))).status).toBe(404);
    h.ctx = member(insider);
    expect((await updateContract(req("PUT", { title: "MSA v2" }), at({ contractId: id }))).status).toBe(200);
  });
});

describe("custom fields", () => {
  it("an outsider can't add one to the project, nor change or delete one of its fields; the team can", async () => {
    h.ctx = member(outsider);
    const field = (key: string) => ({ name: "Risk", key, fieldType: "TEXT", projectId: restricted });
    expect((await createField(req("POST", field(`risk_${stamp}`)), at({}))).status).toBe(403);
    const id = (await prisma.customField.create({ data: { orgId, projectId: restricted, name: "Risk", key: `r_${stamp}`, fieldType: "TEXT" } })).id;
    expect((await updateField(req("PUT", { name: "x" }), at({ fieldId: id }))).status).toBe(404);
    expect((await deleteField(req("DELETE"), at({ fieldId: id }))).status).toBe(404);
    h.ctx = member(insider);
    expect((await createField(req("POST", field(`risk2_${stamp}`)), at({}))).status).toBe(201);
  });
});

describe("by id: a write that loads a project's record checks that project", () => {
  it("an outsider can't add or remove a meeting's attendees there; the team can", async () => {
    const meetingId = (await prisma.syncMeeting.create({ data: { orgId, projectId: restricted, title: "m", meetingDate: new Date(), createdById: insider } })).id;
    const attendee = await prisma.meetingAttendee.create({ data: { meetingId, userId: insider } });
    h.ctx = member(outsider);
    expect((await addAttendee(req("POST", { userId: outsider }), at({ meetingId }))).status).toBe(404);
    expect((await removeAttendee(req("DELETE"), at({ meetingId, attendeeId: attendee.id }))).status).toBe(404);
    expect(await prisma.meetingAttendee.count({ where: { meetingId } })).toBe(1);
    h.ctx = member(insider);
    expect((await addAttendee(req("POST", { userId: outsider }), at({ meetingId }))).status).toBeLessThan(300);
  });

  it("an outsider can't bind a project's custom field to a work-item type", async () => {
    const typeId = (await prisma.workItemType.create({ data: { orgId, key: `t_${stamp}`, name: "T" } })).id;
    const customFieldId = (await prisma.customField.create({ data: { orgId, projectId: restricted, name: "R", key: `b_${stamp}`, fieldType: "TEXT" } })).id;
    h.ctx = member(outsider);
    expect((await bindField(req("POST", { action: "bind", customFieldId }), at({ typeId }))).status).toBe(404);
    expect(await prisma.workItemTypeField.count({ where: { workItemTypeId: typeId } })).toBe(0);
    h.ctx = member(insider);
    expect((await bindField(req("POST", { action: "bind", customFieldId }), at({ typeId }))).status).toBeLessThan(300);
  });
});
