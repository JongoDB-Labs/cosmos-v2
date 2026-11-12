// @vitest-environment node
//
// The JSON import creates records the way the product's own forms do: from the
// fields a person may type, as the importer, at the start of their workflow.
//
// It used to copy every column of each row it was given. So an import could
// create an expense already APPROVED by someone else and attached to an
// invoice, a note "written" by another member, a revenue booked in someone
// else's name, or rows pointing at another org's records -- and it recorded
// nothing in the audit log.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as importJson } from "./json/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", otherOrg = "", importer = "", someoneElse = "", projectId = "", foreignClin = "", ownClin = "";
let hiddenProject = "", hiddenClin = "";

const IMPORTER =
  Permission.ORG_READ | Permission.PROJECT_READ | Permission.ORG_IMPORT | Permission.NOTE_CREATE |
  Permission.CRM_CREATE | Permission.FINANCE_READ | Permission.FINANCE_MANAGE;
const as = (permissions: bigint): AuthContext => ({
  userId: importer, orgId, orgRole: "MEMBER", abacRules: [], permissions, basePermissions: permissions,
});
const post = (body: unknown) =>
  importJson(
    new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ orgId }) },
  );

beforeAll(async () => {
  importer = (await prisma.user.create({ data: { email: `importer-${stamp}@import.test`, displayName: "Importer" } })).id;
  someoneElse = (await prisma.user.create({ data: { email: `else-${stamp}@import.test`, displayName: "Else" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `import ${stamp}`, slug: `import-${stamp}` } })).id;
  otherOrg = (await prisma.organization.create({ data: { name: `other ${stamp}`, slug: `other-${stamp}` } })).id;
  for (const userId of [importer, someoneElse]) {
    await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } });
  }
  projectId = (await prisma.project.create({ data: { orgId, name: "Mine", key: `IM${stamp.slice(0, 3).toUpperCase()}` } })).id;
  const otherProject = (await prisma.project.create({ data: { orgId: otherOrg, name: "Theirs", key: `IT${stamp.slice(0, 3).toUpperCase()}` } })).id;
  ownClin = (await prisma.clin.create({ data: { orgId, projectId, code: "0001", title: "Base" } })).id;
  // In this org, but team-scoped and the importer is not on the team.
  hiddenProject = (await prisma.project.create({
    data: { orgId, name: "Closed", key: `IH${stamp.slice(0, 3).toUpperCase()}`, teamScopedAccess: true },
  })).id;
  hiddenClin = (await prisma.clin.create({ data: { orgId, projectId: hiddenProject, code: "0001", title: "Closed" } })).id;
  foreignClin = (await prisma.clin.create({ data: { orgId: otherOrg, projectId: otherProject, code: "0001", title: "Theirs" } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrg] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [importer, someoneElse] } } }).catch(() => undefined);
});

describe("what an imported row may set", () => {
  it("an expense arrives as the importer's DRAFT: no approval, approver or forced id", async () => {
    h.ctx = as(IMPORTER);
    const forcedId = randomUUID();
    const res = await post({
      expenses: [{
        id: forcedId, orgId: otherOrg, amount: "250.00", date: "2026-10-09T00:00:00.000Z", category: `imp-${stamp}`,
        status: "APPROVED", approvedById: someoneElse, approvedAt: "2026-10-10T00:00:00.000Z",
        submittedAt: "2026-10-09T00:00:00.000Z", createdById: someoneElse,
        projectId, clinId: ownClin,
      }],
    });
    expect(res.status).toBe(200);
    const row = await prisma.expense.findFirstOrThrow({ where: { orgId, category: `imp-${stamp}` } });
    expect(row.id).not.toBe(forcedId);
    expect(row).toMatchObject({
      status: "DRAFT", approvedById: null, approvedAt: null, submittedAt: null, invoiceId: null,
      createdById: importer, projectId, clinId: ownClin,
    });
    expect(Number(row.amount)).toBe(250);
  });

  it("an invoice link in the row is ignored: billing attaches expenses, an import does not", async () => {
    h.ctx = as(IMPORTER);
    // This org's own invoice, so the row passes the reference check (an
    // invoice from elsewhere skips the row) and only the link is dropped.
    const invoiceId = (await prisma.invoice.create({
      data: { orgId, number: `INV-${stamp}`, billToName: "Client", createdById: importer },
    })).id;
    await post({ expenses: [{ amount: 3, date: "2026-10-09", category: `inv-${stamp}`, invoiceId }] });
    const row = await prisma.expense.findFirstOrThrow({ where: { orgId, category: `inv-${stamp}` } });
    expect(row.invoiceId).toBeNull();
  });

  it("a row naming an invoice that is not this org's is skipped", async () => {
    h.ctx = as(IMPORTER);
    await post({ expenses: [{ amount: 3, date: "2026-10-09", category: `inv-x-${stamp}`, invoiceId: randomUUID() }] });
    expect(await prisma.expense.count({ where: { orgId, category: `inv-x-${stamp}` } })).toBe(0);
  });

  it("a note and a revenue are the importer's own, whatever the row says", async () => {
    h.ctx = as(IMPORTER);
    await post({
      notes: [{ title: `note-${stamp}`, content: "x", visibility: "ORG", authorId: someoneElse }],
      revenues: [{ amount: "10.00", date: "2026-10-09", type: "ONE_TIME", description: `rev-${stamp}`, createdById: someoneElse }],
    });
    expect((await prisma.note.findFirstOrThrow({ where: { orgId, title: `note-${stamp}` } })).authorId).toBe(importer);
    expect((await prisma.revenue.findFirstOrThrow({ where: { orgId, description: `rev-${stamp}` } })).createdById).toBe(importer);
  });

  it("a row pointing at another org's CLIN is skipped, and counted as skipped", async () => {
    h.ctx = as(IMPORTER);
    const res = await post({ expenses: [{ amount: 5, date: "2026-10-09", category: `foreign-${stamp}`, clinId: foreignClin }] });
    const body = (await res.json()) as { imported: Record<string, number>; skipped: Record<string, number> };
    expect(body.imported.expenses).toBe(0);
    expect(body.skipped.expenses).toBe(1);
    expect(await prisma.expense.count({ where: { orgId, category: `foreign-${stamp}` } })).toBe(0);
  });
});

describe("a project in this org the importer cannot open", () => {
  it("a row filed under it, or under one of its CLINs, is skipped; one under the importer's own project is not", async () => {
    h.ctx = as(IMPORTER);
    const tag = `closed-${stamp}`;
    const res = await post({
      expenses: [
        { amount: 1, date: "2026-10-09", category: tag, projectId: hiddenProject },
        { amount: 2, date: "2026-10-09", category: tag, clinId: hiddenClin },
        { amount: 3, date: "2026-10-09", category: tag, projectId, clinId: ownClin },
      ],
    });
    const body = (await res.json()) as { imported: Record<string, number>; skipped: Record<string, number> };
    expect(body).toMatchObject({ imported: { expenses: 1 }, skipped: { expenses: 2 } });
    const rows = await prisma.expense.findMany({ where: { orgId, category: tag } });
    expect(rows.map((r) => [r.projectId, r.clinId])).toEqual([[projectId, ownClin]]);
  });
});

describe("who may import what", () => {
  it("expenses need FINANCE_MANAGE, as creating one does; nothing is created without it", async () => {
    h.ctx = as(IMPORTER & ~Permission.FINANCE_MANAGE);
    const res = await post({ expenses: [{ amount: 1, date: "2026-10-09", category: `nobit-${stamp}` }] });
    expect(res.status).toBe(403);
    expect(await prisma.expense.count({ where: { orgId, category: `nobit-${stamp}` } })).toBe(0);
  });
});

describe("the audit trail", () => {
  it("one audit row per import, with what was imported and skipped", async () => {
    h.ctx = as(IMPORTER);
    const before = await prisma.auditLog.count({ where: { orgId, action: "org.data_imported" } });
    await post({ partners: [{ name: `partner-${stamp}` }], products: [{ name: `product-${stamp}`, price: "12.50" }] });
    const rows = await prisma.auditLog.findMany({ where: { orgId, action: "org.data_imported" }, orderBy: { createdAt: "desc" } });
    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({ userId: importer });
    expect(rows[0].metadata).toMatchObject({ partners: "1", products: "1" });
    expect(Number((await prisma.product.findFirstOrThrow({ where: { orgId, name: `product-${stamp}` } })).price)).toBe(12.5);
  });
});
