// @vitest-environment node
//
// Changing the logo and its audit row are one write: the row is written in the
// transaction that changes the org, so a row that can't be written rolls the
// change back instead of leaving it unrecorded. The same rule the feedback
// automation settings follow (lib/feedback/automation-operator.server.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown, failAudit: false }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ delete: async () => undefined, put: async () => undefined }) }));
// The real logAudit, unless the test says the audit store is down.
vi.mock("@/lib/audit", async (orig) => {
  const real = await orig<typeof import("@/lib/audit")>();
  return {
    ...real,
    logAudit: async (...args: Parameters<typeof real.logAudit>) => {
      if (h.failAudit) throw new Error("audit store unavailable");
      return real.logAudit(...args);
    },
  };
});

import * as logo from "./route";

// A 1x1 PNG, so the upload passes the type sniff.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", ownerId = "";
const KEY = () => `${orgId}/branding/logo-before.png`;
const URL_BEFORE = () => `/api/v1/orgs/${orgId}/logo?v=before`;

type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = (handler: unknown, req: NextRequest) => (handler as Handler)(req, { params: Promise.resolve({ orgId }) });
const upload = () => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(PNG)], "logo.png", { type: "image/png" }));
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/logo`, { method: "POST", body: form });
};
const remove = () => new NextRequest(`http://localhost/api/v1/orgs/${orgId}/logo`, { method: "DELETE" });
const orgNow = () => prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { logoUrl: true, settings: true } });
const rows = (action: string) => prisma.auditLog.count({ where: { orgId, action } });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `logo tx ${stamp}`, slug: `logo-tx-${stamp}` } })).id;
  ownerId = (await prisma.user.create({ data: { email: `o-${stamp}@logo-tx.test`, displayName: "Owner" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER", permissions: "0" } });
  h.ctx = {
    userId: ownerId, orgId, orgRole: OrgRole.OWNER, abacRules: [],
    permissions: RolePermissions.OWNER, basePermissions: RolePermissions.OWNER,
  } satisfies AuthContext;
});

beforeEach(async () => {
  h.failAudit = false;
  await prisma.organization.update({
    where: { id: orgId },
    data: { logoUrl: URL_BEFORE(), settings: { logoStorageKey: KEY(), logoContentType: "image/png", brandName: "Kept" } },
  });
});

afterEach(() => {
  h.failAudit = false;
});

afterAll(async () => {
  await prisma.orgMember.deleteMany({ where: { orgId } }).catch(() => undefined);
  // Audit rows are append-only, so the org that wrote them may not delete.
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
});

describe("a logo change and its audit row are written together", () => {
  it("an upload whose row can't be written changes nothing", async () => {
    h.failAudit = true;
    const res = await call(logo.POST, upload());
    expect(res.status).toBe(500);
    const org = await orgNow();
    expect(org.logoUrl).toBe(URL_BEFORE());
    expect(org.settings).toMatchObject({ logoStorageKey: KEY(), brandName: "Kept" });
  });

  it("an upload with its row changes the logo and records it (positive control)", async () => {
    const before = await rows("logo.uploaded");
    const res = await call(logo.POST, upload());
    expect(res.status, await res.clone().text()).toBe(200);
    const org = await orgNow();
    expect(org.logoUrl).not.toBe(URL_BEFORE());
    expect((org.settings as { logoStorageKey?: string }).logoStorageKey).not.toBe(KEY());
    expect(org.settings).toMatchObject({ brandName: "Kept" });
    expect(await rows("logo.uploaded")).toBe(before + 1);
  });

  it("a removal whose row can't be written leaves the logo in place", async () => {
    h.failAudit = true;
    const res = await call(logo.DELETE, remove());
    expect(res.status).toBe(500);
    const org = await orgNow();
    expect(org.logoUrl).toBe(URL_BEFORE());
    expect(org.settings).toMatchObject({ logoStorageKey: KEY(), logoContentType: "image/png" });
  });

  it("a removal with its row removes the logo and records it (positive control)", async () => {
    const before = await rows("logo.deleted");
    const res = await call(logo.DELETE, remove());
    expect(res.status).toBe(204);
    const org = await orgNow();
    expect(org.logoUrl).toBeNull();
    expect(org.settings).not.toHaveProperty("logoStorageKey");
    expect(org.settings).toMatchObject({ brandName: "Kept" });
    expect(await rows("logo.deleted")).toBe(before + 1);
  });
});
