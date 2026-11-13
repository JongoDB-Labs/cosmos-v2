// @vitest-environment node
//
// Reads that named a team-scoped project's records and never asked whether the
// caller may open that project.
//
// - Analytics for ONE project (its summary, sprint velocity, interval velocity)
//   checked only the ANALYTICS_READ bit, which every MEMBER and VIEWER holds,
//   while the portfolio roll-up beside them already dropped hidden projects.
// - A contract's PDF and its signature status checked only CRM_READ, while the
//   contract itself answers 404 to somebody outside its project.
// - A partner's and a product's detail listed every contract with them, a
//   hidden project's included, with value and terms; the contract list does not.
//
// Each refusal is paired with the same request from a member of the project's
// team, so it cannot pass by the route simply being broken.
// Through the real routes, against a real database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET as projectAnalytics } from "@/app/api/v1/orgs/[orgId]/analytics/projects/[projectId]/route";
import { GET as sprintAnalytics } from "@/app/api/v1/orgs/[orgId]/analytics/sprints/route";
import { GET as intervalAnalytics } from "@/app/api/v1/orgs/[orgId]/analytics/intervals/route";
import { GET as contractPdf } from "@/app/api/v1/orgs/[orgId]/contracts/[contractId]/pdf/route";
import { GET as signatureStatus } from "@/app/api/v1/orgs/[orgId]/contracts/[contractId]/signature/status/route";
import { GET as getPartner } from "@/app/api/v1/orgs/[orgId]/partners/[partnerId]/route";
import { GET as listPartners } from "@/app/api/v1/orgs/[orgId]/partners/route";
import { GET as getProduct } from "@/app/api/v1/orgs/[orgId]/products/[productId]/route";
import { GET as listProducts } from "@/app/api/v1/orgs/[orgId]/products/route";
import { GET as listContracts } from "@/app/api/v1/orgs/[orgId]/contracts/route";
import { GET as getContract, PUT as putContract, DELETE as deleteContract } from "@/app/api/v1/orgs/[orgId]/contracts/[contractId]/route";
import { POST as sendForSignature } from "@/app/api/v1/orgs/[orgId]/contracts/[contractId]/signature/route";
import type { AbacRule } from "@/lib/abac/engine";

const stamp = Math.random().toString(36).slice(2, 8);
const SPRINT_NAME = `hidden-sprint-${stamp}`;
const ASSIGNEE_NAME = `Insider ${stamp}`;
const HIDDEN_CONTRACT = `hidden-contract-${stamp}`;
const OPEN_CONTRACT = `open-contract-${stamp}`;

let orgId = "", restricted = "", open = "", outsider = "", insider = "";
let hiddenContract = "", partnerId = "", productId = "";

beforeAll(async () => {
  outsider = (await prisma.user.create({ data: { email: `out-${stamp}@tsac.test`, displayName: "Outsider" } })).id;
  insider = (await prisma.user.create({ data: { email: `in-${stamp}@tsac.test`, displayName: ASSIGNEE_NAME } })).id;
  orgId = (await prisma.organization.create({ data: { name: `tsac ${stamp}`, slug: `tsac-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: outsider, role: "MEMBER", permissions: "0" } });
  const insiderMembership = await prisma.orgMember.create({ data: { orgId, userId: insider, role: "MEMBER", permissions: "0" } });
  const key = stamp.slice(0, 3).toUpperCase();
  restricted = (await prisma.project.create({ data: { orgId, name: "R", key: `AR${key}`, teamScopedAccess: true } })).id;
  open = (await prisma.project.create({ data: { orgId, name: "O", key: `AO${key}` } })).id;
  await prisma.projectMember.create({ data: { projectId: restricted, orgMemberId: insiderMembership.id, role: "MEMBER" } });
  await ensureFixtureStatuses(restricted);

  const sprint = await prisma.interval.create({
    data: {
      orgId, projectId: restricted, number: 1, name: SPRINT_NAME, status: "COMPLETED",
      startDate: new Date("2026-01-01"), endDate: new Date("2026-01-14"),
    },
  });
  const typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
  const wi = await createFixtureWorkItem({
    orgId, projectId: restricted, workItemTypeId: typeId, createdById: insider, title: "w", columnKey: "todo",
  });
  await prisma.workItem.update({
    where: { id: wi.id },
    data: { assigneeId: insider, intervalId: sprint.id, storyPoints: 5, completedAt: new Date("2026-01-10") },
  });

  partnerId = (await prisma.partner.create({ data: { orgId, name: `Vendor ${stamp}` } })).id;
  productId = (await prisma.product.create({ data: { orgId, name: `Widget ${stamp}` } })).id;
  hiddenContract = (await prisma.contract.create({
    data: {
      orgId, projectId: restricted, partnerId, productId, title: HIDDEN_CONTRACT,
      value: 123456, terms: `secret terms ${stamp}`, docusignEnvelopeId: `env-${stamp}`,
    },
  })).id;
  await prisma.contract.create({ data: { orgId, projectId: open, partnerId, productId, title: OPEN_CONTRACT } });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [outsider, insider] } } }).catch(() => undefined);
});

/** An ordinary member's session: the MEMBER role's bits. */
const as = (userId: string, abacRules: AbacRule[] = []) => {
  const ctx: AuthContext = {
    userId, orgId, orgRole: "MEMBER", abacRules,
    permissions: RolePermissions.MEMBER, basePermissions: RolePermissions.MEMBER,
  };
  h.ctx = ctx;
};
const get = (qs = "") => new NextRequest(`http://localhost/x${qs}`);
const org = () => ({ params: Promise.resolve({ orgId }) });
const refused = (status: number) => expect([403, 404]).toContain(status);

describe("analytics for one project ask whether the caller may open it", () => {
  const asks = [
    ["the project summary", () => projectAnalytics(get(), { params: Promise.resolve({ orgId, projectId: restricted }) }), ASSIGNEE_NAME],
    ["sprint velocity", () => sprintAnalytics(get(`?projectId=${restricted}`), org()), SPRINT_NAME],
    ["interval velocity", () => intervalAnalytics(get(`?projectId=${restricted}`), org()), SPRINT_NAME],
  ] as const;

  for (const [what, call, secret] of asks) {
    it(`${what}: refused to an outsider, served to the team`, async () => {
      as(outsider);
      const denied = await call();
      refused(denied.status);
      expect(await denied.text()).not.toContain(secret);

      as(insider);
      const allowed = await call();
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toContain(secret);
    });
  }

  it("an open project's analytics still serve the outsider", async () => {
    as(outsider);
    expect((await projectAnalytics(get(), { params: Promise.resolve({ orgId, projectId: open }) })).status).toBe(200);
    expect((await sprintAnalytics(get(`?projectId=${open}`), org())).status).toBe(200);
  });
});

describe("a hidden project's contract is not reachable through its PDF or signature status", () => {
  const at = () => ({ params: Promise.resolve({ orgId, contractId: hiddenContract }) });

  it("PDF: 404 to an outsider; the PDF to the team", async () => {
    as(outsider);
    expect((await contractPdf(get(), at())).status).toBe(404);
    as(insider);
    const ok = await contractPdf(get(), at());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
  });

  it("signature status: 404 to an outsider, and the row is not touched; served to the team", async () => {
    const before = await prisma.contract.findUniqueOrThrow({ where: { id: hiddenContract }, select: { updatedAt: true } });
    as(outsider);
    expect((await signatureStatus(get(), at())).status).toBe(404);
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: hiddenContract }, select: { updatedAt: true } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    as(insider);
    // DocuSign is not configured here, so the team gets the stored status.
    expect((await signatureStatus(get(), at())).status).toBe(200);
  });
});

describe("partner and product detail list only the contracts the caller may see", () => {
  const titles = async (res: Response) =>
    ((await res.json()) as { contracts: Array<{ title: string }> }).contracts.map((c) => c.title);

  it("partner: the outsider sees the open project's contract only; the team sees both", async () => {
    const at = { params: Promise.resolve({ orgId, partnerId }) };
    as(outsider);
    const seen = await titles(await getPartner(get(), at));
    expect(seen).toContain(OPEN_CONTRACT);
    expect(seen).not.toContain(HIDDEN_CONTRACT);
    as(insider);
    expect(await titles(await getPartner(get(), at))).toEqual(expect.arrayContaining([OPEN_CONTRACT, HIDDEN_CONTRACT]));
  });

  it("product: the same", async () => {
    const at = { params: Promise.resolve({ orgId, productId }) };
    as(outsider);
    const seen = await titles(await getProduct(get(), at));
    expect(seen).toContain(OPEN_CONTRACT);
    expect(seen).not.toContain(HIDDEN_CONTRACT);
    as(insider);
    expect(await titles(await getProduct(get(), at))).toEqual(expect.arrayContaining([OPEN_CONTRACT, HIDDEN_CONTRACT]));
  });

  it("the partner and product lists count only those contracts too", async () => {
    type Row = { id: string; _count: { contracts: number } };
    const count = async (res: Response, id: string) => ((await res.json()) as Row[]).find((r) => r.id === id)?._count.contracts;
    as(outsider);
    expect(await count(await listPartners(get(), org()), partnerId)).toBe(1);
    expect(await count(await listProducts(get(), org()), productId)).toBe(1);
    as(insider);
    expect(await count(await listPartners(get(), org()), partnerId)).toBe(2);
    expect(await count(await listProducts(get(), org()), productId)).toBe(2);
  });
});

describe("contracts are CRM data: CRM_READ on their project decides every door", () => {
  // The insider can see the limited project; a rule then denies them CRM data on it.
  const denyOn = (action: string): AbacRule[] =>
    [{ effect: "deny", actions: [action], conditions: [{ attr: "projectId", op: "eq", value: restricted }] }] as AbacRule[];
  const at = () => ({ params: Promise.resolve({ orgId, contractId: hiddenContract }) });
  const listed = async () => ((await (await listContracts(get(), org())).json()) as Array<{ title: string }>).map((c) => c.title);
  const json = (body: unknown, method: string) =>
    new NextRequest("http://localhost/x", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

  it("control: without a rule the insider reads it by id and finds it listed", async () => {
    as(insider);
    expect((await getContract(get(), at())).status).toBe(200);
    expect(await listed()).toContain(HIDDEN_CONTRACT);
  });

  it("an ITEM_READ rule is not the one that decides: the contract stays readable", async () => {
    as(insider, denyOn("ITEM_READ"));
    expect(await listed()).toContain(HIDDEN_CONTRACT);
    expect((await getContract(get(), at())).status).toBe(200);
  });

  it("with CRM_READ denied there: not listed, not counted, not in partner detail, and 404 by id, PDF and signature", async () => {
    as(insider, denyOn("CRM_READ"));
    const seen = await listed();
    expect(seen).toContain(OPEN_CONTRACT);
    expect(seen).not.toContain(HIDDEN_CONTRACT);
    const partner = (await (await getPartner(get(), { params: Promise.resolve({ orgId, partnerId }) })).json()) as {
      contracts: Array<{ title: string }>;
    };
    expect(partner.contracts.map((c) => c.title)).toEqual([OPEN_CONTRACT]);
    type Row = { id: string; _count: { contracts: number } };
    const rows = (await (await listPartners(get(), org())).json()) as Row[];
    expect(rows.find((r) => r.id === partnerId)?._count.contracts).toBe(1);
    expect({
      byId: (await getContract(get(), at())).status,
      pdf: (await contractPdf(get(), at())).status,
      status: (await signatureStatus(get(), at())).status,
      send: (await sendForSignature(json({ signerEmail: "signer@example.com", signerName: "Signer" }, "POST"), at())).status,
      update: (await putContract(json({ title: "renamed" }, "PUT"), at())).status,
    }).toEqual({ byId: 404, pdf: 404, status: 404, send: 404, update: 404 });
    // Last, because on a broken gate it really deletes. With CRM_DELETE, so the
    // role is not what refuses: the contract is gone from this caller by its project.
    h.ctx = { ...(h.ctx as AuthContext), permissions: RolePermissions.MEMBER | Permission.CRM_DELETE };
    expect((await deleteContract(get(), at())).status).toBe(404);
    expect(await prisma.contract.findUnique({ where: { id: hiddenContract }, select: { title: true } })).toEqual({
      title: HIDDEN_CONTRACT,
    });
  });
});
