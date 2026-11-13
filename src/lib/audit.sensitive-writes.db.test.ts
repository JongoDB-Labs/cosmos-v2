// @vitest-environment node
//
// Money, pay and org-settings writes leave an audit row naming who did what,
// driven through the real routes against a real database. A sample of the
// writes; audit.sensitive-writes.arch.test.ts holds every listed handler to a
// logAudit call.
//
// Audit rows carry no money: a finance row says what happened, to which
// record, and which fields changed by NAME, never an amount, a rate or a
// cost. The audit log is read by people (and `audit:read` keys) who hold no
// finance permission, so a money value there would be read around the gate
// that guards it.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ delete: async () => undefined, put: async () => undefined }) }));
vi.mock("@/lib/cache/queries", async (orig) => ({ ...(await orig<object>()), revalidateOrg: () => undefined }));

import * as taxRates from "@/app/api/v1/orgs/[orgId]/tax-rates/route";
import * as taxRate from "@/app/api/v1/orgs/[orgId]/tax-rates/[taxRateId]/route";
import * as employee from "@/app/api/v1/orgs/[orgId]/employees/[employeeId]/route";
import * as bankRules from "@/app/api/v1/orgs/[orgId]/bank-rules/route";
import * as bankRule from "@/app/api/v1/orgs/[orgId]/bank-rules/[ruleId]/route";
import * as theme from "@/app/api/v1/orgs/[orgId]/theme/route";
import * as emailSettings from "@/app/api/v1/orgs/[orgId]/email-settings/route";
import * as logo from "@/app/api/v1/orgs/[orgId]/logo/route";
import * as timeOff from "@/app/api/v1/orgs/[orgId]/time-off/route";
import * as timeOffRequest from "@/app/api/v1/orgs/[orgId]/time-off/[requestId]/route";
import * as vendors from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/vendors/route";
import * as vendor from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/vendors/[vendorId]/route";

const VAULT = process.env.SSO_VAULT_KEY;
process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", ownerId = "", workerId = "", employeeId = "", projectId = "", partnerId = "";

const owner = (): AuthContext => ({
  userId: ownerId, orgId, orgRole: OrgRole.OWNER, abacRules: [],
  permissions: RolePermissions.OWNER, basePermissions: RolePermissions.OWNER,
});

type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, params: Record<string, string>, method: string, body?: unknown) {
  h.ctx = owner();
  const req = new NextRequest(`http://localhost/api/v1/orgs/${orgId}/x`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve({ orgId, ...params }) });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return res;
}

/** The newest audit row for `action` in this org. */
async function lastRow(action: string) {
  return prisma.auditLog.findFirst({ where: { orgId, action }, orderBy: { createdAt: "desc" } });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `aud ${stamp}`, slug: `aud-${stamp}` } })).id;
  ownerId = (await prisma.user.create({ data: { email: `o-${stamp}@aud.test`, displayName: "Owner" } })).id;
  workerId = (await prisma.user.create({ data: { email: `w-${stamp}@aud.test`, displayName: "Worker" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: workerId, role: "MEMBER", permissions: "0" } });
  employeeId = (await prisma.employee.create({ data: { orgId, userId: workerId, costRate: "41.5", createdById: ownerId } })).id;
  projectId = (await prisma.project.create({ data: { orgId, name: `Aud ${stamp}`, key: `AUD${stamp.slice(0, 3).toUpperCase()}` } })).id;
  partnerId = (await prisma.partner.create({ data: { orgId, name: `Supplier ${stamp}` } })).id;
});

afterAll(async () => {
  await prisma.contract.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.partner.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.timeOffRequest.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.project.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.employeeCostRate.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.employee.deleteMany({ where: { orgId } }).catch(() => undefined);
  // Audit rows are append-only, so the org that wrote them may not delete.
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, workerId] } } }).catch(() => undefined);
  if (VAULT === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = VAULT;
});

describe("money writes are audited", () => {
  it("a tax rate's create, change and delete each leave a row", async () => {
    const created = (await (await call(taxRates.POST, {}, "POST", { name: `VAT ${stamp}`, rate: 0.2 })).json()) as { id: string };
    expect(await lastRow("tax_rate.created")).toMatchObject({ entity: "tax_rate", entityId: created.id, userId: ownerId });

    await call(taxRate.PUT, { taxRateId: created.id }, "PUT", { rate: 0.21 });
    expect((await lastRow("tax_rate.updated"))?.metadata).toMatchObject({ changed: ["rate"] });

    await call(taxRate.DELETE, { taxRateId: created.id }, "DELETE");
    expect(await lastRow("tax_rate.deleted")).toMatchObject({ entityId: created.id });
  });

  it("a bank rule's create, change and delete each leave a row", async () => {
    const rule = (await (await call(bankRules.POST, {}, "POST", { category: "Travel" })).json()) as { id: string };
    expect(await lastRow("bank_rule.created")).toMatchObject({ entityId: rule.id });
    await call(bankRule.PATCH, { ruleId: rule.id }, "PATCH", { priority: 2 });
    expect(await lastRow("bank_rule.updated")).toMatchObject({ entityId: rule.id });
    await call(bankRule.DELETE, { ruleId: rule.id }, "DELETE");
    expect(await lastRow("bank_rule.deleted")).toMatchObject({ entityId: rule.id });
  });
});

describe("vendor writes are audited without the money", () => {
  it("a vendor's create, change and delete each leave a row naming fields, not amounts", async () => {
    const created = (await (await call(vendors.POST, { projectId }, "POST", { partnerId, title: "Support", value: 12345.67, fundedValue: 2000 })).json()) as { id: string };
    expect(await lastRow("vendor.created")).toMatchObject({ entity: "vendor_contract", entityId: created.id, userId: ownerId });

    await call(vendor.PATCH, { projectId, vendorId: created.id }, "PATCH", { value: 22222.5, status: "completed", pocName: "Pat" });
    const updated = await lastRow("vendor.updated");
    expect(updated).toMatchObject({ entityId: created.id });
    expect((updated?.metadata as { changed: string[] }).changed).toEqual(expect.arrayContaining(["value", "status", "pocName"]));
    // Positive control: the amount did change.
    expect(String((await prisma.contract.findUniqueOrThrow({ where: { id: created.id } })).value)).toBe("22222.5");

    await call(vendor.DELETE, { projectId, vendorId: created.id }, "DELETE");
    expect(await lastRow("vendor.deleted")).toMatchObject({ entityId: created.id });
    expect((await lastRow("vendor.deleted"))?.metadata).toMatchObject({ projectId, partnerId });
  });
});

describe("pay writes are audited without the pay", () => {
  it("a cost-rate change names the field, not the amount", async () => {
    await call(employee.PUT, { employeeId }, "PUT", { costRate: 97.25 });
    const row = await lastRow("employee.updated");
    expect(row).toMatchObject({ entity: "employee", entityId: employeeId, userId: ownerId });
    expect(row?.metadata).toMatchObject({ changed: ["costRate"] });
    expect(JSON.stringify(row?.metadata)).not.toContain("97.25");
    // Positive control: the change itself happened.
    expect(String((await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } })).costRate)).toBe("97.25");
  });

  it("time off filed for someone else names them", async () => {
    const res = await call(timeOff.POST, {}, "POST", { kind: "VACATION", startDate: "2026-12-01", endDate: "2026-12-02", userId: workerId });
    const body = (await res.json()) as { id: string };
    expect(await lastRow("time_off.filed_for")).toMatchObject({ entityId: body.id, userId: ownerId });
    expect((await lastRow("time_off.filed_for"))?.metadata).toMatchObject({ userId: workerId, kind: "VACATION" });
  });

  it("time off filed for oneself is on the record too", async () => {
    const res = await call(timeOff.POST, {}, "POST", { kind: "SICK", startDate: "2026-12-07", endDate: "2026-12-07" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(await lastRow("time_off.requested")).toMatchObject({ entityId: body.id, userId: ownerId });
    expect((await lastRow("time_off.requested"))?.metadata).toMatchObject({ subjectUserId: ownerId, kind: "SICK" });
  });

  it("deciding a request leaves a row naming the decision and whose time it was", async () => {
    const res = await call(timeOff.POST, {}, "POST", { kind: "VACATION", startDate: "2026-12-07", endDate: "2026-12-08", userId: workerId });
    const { id } = (await res.json()) as { id: string };
    await call(timeOffRequest.PATCH, { requestId: id }, "PATCH", { action: "deny", decisionNote: "Coverage is thin that week" });
    const row = await lastRow("time_off.decided");
    expect(row).toMatchObject({ entity: "time_off_request", entityId: id, userId: ownerId });
    expect(row?.metadata).toMatchObject({ subjectUserId: workerId, decision: "DENIED" });
    // The note is the approver's free text about a person; the request keeps it, the log doesn't.
    expect(JSON.stringify(row?.metadata)).not.toContain("Coverage");
  });

  it("withdrawing your own request leaves a row too", async () => {
    const res = await call(timeOff.POST, {}, "POST", { kind: "VACATION", startDate: "2026-12-14", endDate: "2026-12-14" });
    const { id } = (await res.json()) as { id: string };
    await call(timeOffRequest.PATCH, { requestId: id }, "PATCH", { action: "withdraw" });
    expect(await lastRow("time_off.withdrawn")).toMatchObject({ entity: "time_off_request", entityId: id, userId: ownerId });
  });
});

/** Keys a money value would sit under. */
const MONEY_KEY = /amount|rate|total|value|cost|price|balance|debit|credit|subtotal|pay/i;
/** Every key in a metadata object, at any depth, and every scalar in it. */
function walk(v: unknown, keys: string[] = [], scalars: unknown[] = []) {
  if (Array.isArray(v)) v.forEach((x) => walk(x, keys, scalars));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x, keys, scalars); }
  else scalars.push(v);
  return { keys, scalars };
}

describe("audit rows carry no money", () => {
  const FINANCE = ["tax_rate", "bank_rule", "employee", "invoice", "bill", "pay_run", "journal_entry", "gl_account", "bank_account", "bank_transaction", "ledger", "vendor_contract"];

  it("no finance row's metadata has a money key or a money value", async () => {
    const rows = await prisma.auditLog.findMany({ where: { orgId, entity: { in: FINANCE } } });
    // Positive control: the money writes above did leave rows to inspect.
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["tax_rate.created", "tax_rate.updated", "employee.updated", "bank_rule.updated", "vendor.created", "vendor.updated"]));
    for (const row of rows) {
      const { keys, scalars } = walk(row.metadata);
      expect(keys.filter((k) => MONEY_KEY.test(k)), row.action).toEqual([]);
      // The amounts this file wrote: a tax rate, a cost rate.
      for (const money of ["0.2", "0.21", "97.25", "41.5", "12345.67", "2000", "22222.5"]) expect(scalars.map(String), row.action).not.toContain(money);
    }
  });

  it("the check would catch one that did (a positive control for the matcher)", () => {
    const { keys, scalars } = walk({ changed: ["costRate"], amount: "97.25", nested: { totalCost: 3 } });
    expect(keys.filter((k) => MONEY_KEY.test(k))).toEqual(["amount", "totalCost"]);
    expect(scalars.map(String)).toContain("97.25");
    // A field NAME in the changed list is not a value.
    expect(walk({ changed: ["costRate"] }).keys.filter((k) => MONEY_KEY.test(k))).toEqual([]);
  });
});

describe("org settings writes are audited", () => {
  it("the theme", async () => {
    await call(theme.PATCH, {}, "PATCH", { brandName: `Brand ${stamp}` });
    expect((await lastRow("theme.updated"))?.metadata).toMatchObject({ changed: ["brandName"] });
  });

  it("email delivery, without the key", async () => {
    const key = `re_${stamp}_secretvalue`;
    await call(emailSettings.PUT, {}, "PUT", { provider: "resend", apiKey: key });
    const row = await lastRow("email_settings.updated");
    expect(row?.metadata).toMatchObject({ apiKeyChanged: true, changed: ["provider"] });
    expect(JSON.stringify(row?.metadata)).not.toContain(key);
  });

  it("removing the logo", async () => {
    await call(logo.DELETE, {}, "DELETE");
    expect(await lastRow("logo.deleted")).toMatchObject({ entity: "organization", entityId: orgId });
  });
});
