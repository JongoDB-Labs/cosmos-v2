// @vitest-environment node
//
// Who may read an org's audit log, against a real database.
//
// An audit row has no project: it records what happened anywhere in the org,
// and its entity, ids and metadata name things in every project. A key limited
// to some projects therefore can't read the log or export it, whatever its
// scopes. An org-wide key with `audit:read` and a browser session can.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/pdf/audit-log", () => ({
  generateAuditLogPdf: async (input: { rows: Array<{ action: string }> }) =>
    Buffer.from(`%PDF-fake ${input.rows.map((r) => r.action).join(" ")}`),
}));

import { GET as list } from "./route";
import { GET as exportLog } from "./export/route";

const stamp = Math.random().toString(36).slice(2, 8);
// Every row this file writes carries this action, so a filter reaches exactly them.
const ACTION = `keyscope.${stamp}`;
let orgId = "", userId = "", projectId = "";

const owner = (): AuthContext => ({
  userId, orgId, orgRole: OrgRole.OWNER, abacRules: [],
  permissions: RolePermissions.OWNER, basePermissions: RolePermissions.OWNER,
});
/** An OWNER's key with `audit:read`, as apiKeyAuthContext builds it. */
const key = (projectScope?: string[]): AuthContext => {
  const mask = RolePermissions.OWNER & scopeMask(["audit:read"]);
  return {
    userId, orgId, orgRole: OrgRole.OWNER, abacRules: [], permissions: mask, basePermissions: mask,
    isApiKey: true, scopes: ["audit:read"], ...(projectScope ? { projectScope } : {}),
  };
};

type Handler = (req: NextRequest, c: { params: Promise<{ orgId: string }> }) => Promise<Response>;
const DOORS: Array<[string, Handler, string]> = [
  ["the list", list as Handler, `/audit-logs?action=${ACTION}`],
  ["the JSON export", exportLog as Handler, `/audit-logs/export?action=${ACTION}`],
  ["the CSV export", exportLog as Handler, `/audit-logs/export?format=csv&action=${ACTION}`],
  ["the PDF export", exportLog as Handler, `/audit-logs/export?format=pdf&action=${ACTION}`],
];
const call = (handler: Handler, path: string) =>
  handler(new NextRequest(`http://localhost/api/v1/orgs/${orgId}${path}`), { params: Promise.resolve({ orgId }) });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `akey ${stamp}`, slug: `akey-${stamp}` } })).id;
  userId = (await prisma.user.create({ data: { email: `o-${stamp}@akey.test`, displayName: "Owner" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "OWNER", permissions: "0" } });
  projectId = (await prisma.project.create({ data: { orgId, name: "Scoped", key: `K${stamp.slice(0, 4).toUpperCase()}` } })).id;
  for (const entity of ["work_item", "project"]) {
    await prisma.auditLog.create({ data: { orgId, userId, action: ACTION, entity, entityId: `${entity}-${stamp}` } });
  }
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  // Audit rows are append-only and outlive the org by design.
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

describe("a key limited to some projects can't read the org-wide audit log", () => {
  it.each(DOORS)("%s: refused, and no row is sent", async (_name, handler, path) => {
    h.ctx = key([projectId]);
    const res = await call(handler, path);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(ACTION);
  });
});

describe.each([
  ["an org-wide key with audit:read", () => key()],
  ["an owner's browser session", owner],
])("%s still reads it", (_who, ctx) => {
  it.each(DOORS)("%s", async (_name, handler, path) => {
    h.ctx = ctx();
    const res = await call(handler, path);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    // A positive control: both rows come back, so the refusal above is the gate
    // and not an empty log.
    expect(text.split(ACTION).length - 1).toBe(2);
  });
});
