// @vitest-environment node
//
// Which projects the org activity feed names, against a real database.
//
// The feed puts a project's key and name on every entry. Work-item activity was
// already drawn from the projects the caller may read; logged time was drawn
// from the people whose hours the caller may read, wherever they logged them.
// So somebody entitled to everyone's hours, who is not on a project limited to
// its members, was shown that project's name through a colleague's entry. Both
// halves now drop entries on a project the caller can't see. Time on no project
// stays, and an administrator, an org-wide key and a key limited to projects
// each read what they read before.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
const HIDDEN_NAME = `Hidden job ${stamp}`;
const HIDDEN_KEY = `AH${stamp.slice(0, 4).toUpperCase()}`;
let orgId = "", O = "", H = "";
const u = { payroll: "", admin: "", worker: "" };

/** A member whose work role lets them read everybody's hours. Not on H. */
const payroll = (): AuthContext => {
  const permissions = RolePermissions.MEMBER | Permission.TIME_READ_ALL;
  return { userId: u.payroll, orgId, orgRole: OrgRole.MEMBER, abacRules: [], permissions, basePermissions: permissions };
};
const admin = (): AuthContext => ({
  userId: u.admin, orgId, orgRole: OrgRole.ADMIN, abacRules: [],
  permissions: RolePermissions.ADMIN, basePermissions: RolePermissions.ADMIN,
});
/** The administrator's key, as apiKeyAuthContext builds it. */
const adminKey = (projectScope?: string[]): AuthContext => {
  const scopes = ["read", "time:read"];
  const mask = RolePermissions.ADMIN & scopeMask(scopes);
  return { ...admin(), permissions: mask, basePermissions: mask, isApiKey: true, scopes, ...(projectScope ? { projectScope } : {}) };
};

type Entry = {
  kind: "work-item" | "time";
  item: { title: string; project: { name: string } } | null;
  time: { description: string; project: { name: string } | null } | null;
};
async function feed(ctx: AuthContext, qs = "") {
  h.ctx = ctx;
  const res = await GET(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/activity${qs}`), {
    params: Promise.resolve({ orgId }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const data = (JSON.parse(text) as { data: Entry[] }).data;
  return {
    text,
    items: data.filter((e) => e.kind === "work-item").map((e) => e.item?.title).sort(),
    time: data.filter((e) => e.kind === "time").map((e) => e.time?.description).sort(),
    hiddenTime: data.find((e) => e.time?.description === "hidden-work")?.time,
  };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `actv ${stamp}`, slug: `actv-${stamp}` } })).id;
  const om: Record<string, string> = {};
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    u[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@actv.test`, displayName: `${k} ${stamp}` } })).id;
    om[k] = (await prisma.orgMember.create({
      data: { orgId, userId: u[k], role: k === "admin" ? "ADMIN" : "MEMBER", permissions: "0" },
    })).id;
  }
  O = (await prisma.project.create({ data: { orgId, name: `Open job ${stamp}`, key: `AO${stamp.slice(0, 4).toUpperCase()}` } })).id;
  H = (await prisma.project.create({ data: { orgId, name: HIDDEN_NAME, key: HIDDEN_KEY, teamScopedAccess: true } })).id;
  // The worker is on H; nobody else is.
  await prisma.projectMember.create({ data: { projectId: H, orgMemberId: om.worker } });

  const typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
  for (const [projectId, title] of [[O, "open-item"], [H, "hidden-item"]] as const) {
    await prisma.workflowStatus.create({ data: { orgId, projectId, key: "todo", name: "To Do", category: "TODO" } });
    const item = await prisma.workItem.create({
      data: { orgId, projectId, workItemTypeId: typeId, createdById: u.worker, title, description: "", columnKey: "todo", ticketNumber: 1 },
    });
    await prisma.activity.create({ data: { orgId, workItemId: item.id, userId: u.worker, action: "updated", field: "title" } });
  }
  const entries: Array<[string | null, string, string]> = [[O, "open-work", "2026-03-03"], [H, "hidden-work", "2026-03-04"], [null, "overhead", "2026-03-05"]];
  for (const [projectId, description, date] of entries) {
    await prisma.timeEntry.create({
      data: { orgId, userId: u.worker, projectId, description, date: new Date(date), hours: 2, status: "SUBMITTED" },
    });
  }
  // Routed to the administrator, which is what lets the administrator's KEY
  // read the worker's hours (a key holds TIME_READ, not TIME_READ_ALL).
  await prisma.timesheet.create({
    data: {
      orgId, userId: u.worker, periodStart: new Date("2026-03-02"), periodEnd: new Date("2026-03-08"),
      status: "SUBMITTED", approverIds: [u.admin],
    },
  });
});

afterAll(async () => {
  await prisma.timeEntry.deleteMany({ where: { orgId } });
  await prisma.timesheet.deleteMany({ where: { orgId } });
  await prisma.workItem.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } }).catch(() => undefined);
});

describe("somebody who reads everyone's hours, but is not on a limited project", () => {
  it("sees no entry on that project, and never its name or key", async () => {
    const f = await feed(payroll());
    expect(f.time).toEqual(["open-work", "overhead"]);
    expect(f.items).toEqual(["open-item"]);
    expect(f.text).not.toContain(HIDDEN_NAME);
    expect(f.text).not.toContain(HIDDEN_KEY);
  });

  it("gets nothing by asking for that project", async () => {
    const f = await feed(payroll(), `?projectId=${H}`);
    expect([...f.time, ...f.items]).toEqual([]);
  });
});

describe.each([
  ["an administrator in person", admin],
  ["the administrator's org-wide key", () => adminKey()],
])("%s reads the whole feed as before", (_who, ctx) => {
  it("every entry, the limited project named", async () => {
    const f = await feed(ctx());
    expect(f.time).toEqual(["hidden-work", "open-work", "overhead"]);
    expect(f.items).toEqual(["hidden-item", "open-item"]);
    // A positive control for the absence above: the same probe sees the name.
    expect(f.hiddenTime?.project?.name).toBe(HIDDEN_NAME);
  });
});

describe("a key limited to one project", () => {
  it("reads that project's work and hours only", async () => {
    const f = await feed(adminKey([O]));
    expect(f.time).toEqual(["open-work"]);
    expect(f.items).toEqual(["open-item"]);
  });
});
