// @vitest-environment node
//
// A contract's value, funded value and invoiced value are finance data, in the
// CRM exactly as on the vendor register.
//
// The vendor register already withheld them from a reader without finance
// access, but the CRM routes served the same rows on CRM_READ, which VIEWER and
// MEMBER both hold: a read-only member saw a contract's value on /contracts
// while the vendor register said "Restricted" for the same contract. The rule
// is the register's: FINANCE_READ, or FINANCE_READ_PROJECT on a project the
// reader is a member of. A contract with no project needs the org-wide grant.
// Without it the contract still arrives, with the money fields left out.
//
// A partner's and a product's contracts also listed contracts on projects the
// reader cannot open; they now follow the contract list's project rule.
//
// Against a real database. Each refusal has a reader who does see the figure,
// so an assertion of absence can't pass on an empty response.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";
import { NextRequest } from "next/server";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
// Sending for signature is a third-party call.
vi.mock("@/lib/integrations/docusign", () => ({ createEnvelope: async () => "env-1" }));

import { GET as listContracts, POST as createContract } from "./route";
import { GET as getContract, PUT as putContract } from "./[contractId]/route";
import { GET as contractPdf } from "./[contractId]/pdf/route";
import { POST as sendForSignature } from "./[contractId]/signature/route";
import { GET as getPartner } from "../partners/[partnerId]/route";
import { GET as getProduct } from "../products/[productId]/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", projectId = "", hiddenProjectId = "", partnerId = "", productId = "";
let onProject = "", orgLevel = "", onHidden = "";
const users: Record<string, string> = {};

// Distinctive figures, so a search of the whole payload can't match by accident.
const VALUE = 918_273;
const FUNDED = 827_364;
const INVOICED = 736_455;
const ORG_VALUE = 615_243;
const HIDDEN_VALUE = 514_326;
const MONEY = ["value", "fundedValue", "invoicedValue"];
const FIGURES = [VALUE, FUNDED, INVOICED, ORG_VALUE, HIDDEN_VALUE].map(String);

const base = { orgRole: "MEMBER" as const, abacRules: [], basePermissions: 0n };
const VIEWER = RolePermissions.VIEWER;
const as = (who: string, permissions: bigint): AuthContext => ({ ...base, userId: users[who], orgId, permissions });

/** The built-in VIEWER role: CRM_READ, no finance bit. A member of the open project. */
const viewer = () => as("viewer", VIEWER);
/** The built-in MEMBER role, which may edit contracts and has no finance bit. */
const editor = () => as("editor", RolePermissions.MEMBER);
/** Org-wide finance. */
const finance = () => as("finance", VIEWER | Permission.FINANCE_READ);
/** Project-limited finance, on the open project, which they are a member of. */
const memberFinance = () => as("memberFinance", VIEWER | Permission.FINANCE_READ_PROJECT);
/** A member of the team-scoped project, without finance access. */
const insider = () => as("insider", VIEWER);

const at = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ orgId, ...extra }) }) as never;
const get = () => new NextRequest("http://localhost/x");
const json = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

type Row = Record<string, unknown> & { id: string };

async function body<T = unknown>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

function figuresIn(x: unknown): string[] {
  const s = JSON.stringify(x);
  return FIGURES.filter((f) => s.includes(f));
}

function expectNoMoney(row: Row | undefined) {
  expect(row, "the contract itself still arrives").toBeDefined();
  for (const k of MONEY) expect(row, k).not.toHaveProperty(k);
}

/**
 * The text a PDF draws. PDFKit compresses each page's content stream and
 * writes a standard font's text as hex strings, so: inflate every stream and
 * decode every hex string in it.
 */
function pdfText(buf: ArrayBuffer): string {
  const s = Buffer.from(buf).toString("latin1");
  let out = "";
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      content = m[1];
    }
    for (const t of content.matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(t[1], "hex").toString("latin1");
    out += "\n";
  }
  return out;
}

beforeAll(async () => {
  for (const who of ["viewer", "editor", "finance", "memberFinance", "insider"]) {
    users[who] = (await prisma.user.create({ data: { email: `${who}-${stamp}@crm-money.test`, displayName: who } })).id;
  }
  orgId = (await prisma.organization.create({ data: { name: `crm money ${stamp}`, slug: `crm-money-${stamp}` } })).id;
  const memberships: Record<string, string> = {};
  for (const [who, id] of Object.entries(users)) {
    memberships[who] = (await prisma.orgMember.create({ data: { orgId, userId: id, role: "MEMBER", permissions: "0" } })).id;
  }
  projectId = (await prisma.project.create({ data: { orgId, name: "Open", key: `CM${stamp.slice(0, 4).toUpperCase()}` } })).id;
  hiddenProjectId = (await prisma.project.create({
    data: { orgId, name: "Closed", key: `CH${stamp.slice(0, 4).toUpperCase()}`, teamScopedAccess: true },
  })).id;
  for (const who of ["viewer", "editor", "memberFinance"]) {
    await prisma.projectMember.create({ data: { projectId, orgMemberId: memberships[who], role: "MEMBER" } });
  }
  await prisma.projectMember.create({ data: { projectId: hiddenProjectId, orgMemberId: memberships.insider, role: "MEMBER" } });

  partnerId = (await prisma.partner.create({ data: { orgId, name: "Sub Co", contactEmail: "sub@example.com" } })).id;
  productId = (await prisma.product.create({ data: { orgId, name: "Widget" } })).id;
  onProject = (await prisma.contract.create({
    data: { orgId, projectId, partnerId, productId, title: "Project subaward", value: VALUE, fundedValue: FUNDED, invoicedValue: INVOICED },
  })).id;
  orgLevel = (await prisma.contract.create({
    data: { orgId, partnerId, productId, title: "Master agreement", value: ORG_VALUE },
  })).id;
  onHidden = (await prisma.contract.create({
    data: { orgId, projectId: hiddenProjectId, partnerId, productId, title: "Closed subaward", value: HIDDEN_VALUE },
  })).id;
});

afterAll(async () => {
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } }).catch(() => undefined);
});

describe("contract list", () => {
  it("a reader without finance access gets the contracts without their money", async () => {
    h.ctx = viewer();
    const rows = await body<Row[]>(await listContracts(get(), at()));
    expectNoMoney(rows.find((r) => r.id === onProject));
    expectNoMoney(rows.find((r) => r.id === orgLevel));
    expect(figuresIn(rows)).toEqual([]);
  });

  it("control: org-wide finance sees every figure", async () => {
    h.ctx = finance();
    const rows = await body<Row[]>(await listContracts(get(), at()));
    const row = rows.find((r) => r.id === onProject)!;
    expect([Number(row.value), Number(row.fundedValue), Number(row.invoicedValue)]).toEqual([VALUE, FUNDED, INVOICED]);
    expect(Number(rows.find((r) => r.id === orgLevel)!.value)).toBe(ORG_VALUE);
  });

  it("project finance sees money on its own project, and not on an org-level contract", async () => {
    h.ctx = memberFinance();
    const rows = await body<Row[]>(await listContracts(get(), at()));
    expect(Number(rows.find((r) => r.id === onProject)!.value)).toBe(VALUE);
    expectNoMoney(rows.find((r) => r.id === orgLevel));
  });
});

describe("one contract", () => {
  it("a reader without finance access gets it without its money", async () => {
    h.ctx = viewer();
    const row = await body<Row>(await getContract(get(), at({ contractId: onProject })));
    expect(row.title).toBe("Project subaward");
    expectNoMoney(row);
  });

  it("control: finance sees the figures", async () => {
    h.ctx = finance();
    const row = await body<Row>(await getContract(get(), at({ contractId: onProject })));
    expect(Number(row.value)).toBe(VALUE);
  });

  it("an edit by someone without finance access answers without the money, and keeps it", async () => {
    h.ctx = editor();
    const row = await body<Row>(await putContract(json("PUT", { notes: "renewal due" }), at({ contractId: onProject })));
    expect(row.notes).toBe("renewal due");
    expectNoMoney(row);
    const stored = await prisma.contract.findUniqueOrThrow({ where: { id: onProject } });
    expect(Number(stored.value)).toBe(VALUE);
  });

  it("a new org-level contract answers without its money unless the creator has org finance", async () => {
    h.ctx = editor();
    const mine = await body<Row>(await createContract(json("POST", { title: "Teaming", value: 4_242 }), at()), 201);
    expectNoMoney(mine);
    h.ctx = as("finance", RolePermissions.MEMBER | Permission.FINANCE_READ);
    const theirs = await body<Row>(await createContract(json("POST", { title: "Teaming 2", value: 4_243 }), at()), 201);
    expect(Number(theirs.value)).toBe(4_243);
  });

  it("sending for signature answers without the money", async () => {
    h.ctx = editor();
    const out = await body<{ contract: Row }>(await sendForSignature(
      json("POST", { signerEmail: "signer@example.com", signerName: "Signer", documentBase64: "UEs=" }),
      at({ contractId: onProject }),
    ));
    expect(out.contract.id).toBe(onProject);
    expectNoMoney(out.contract);
  });
});

describe("a partner's and a product's contracts", () => {
  for (const [name, read, id] of [
    ["partner", getPartner, () => ({ partnerId })],
    ["product", getProduct, () => ({ productId })],
  ] as const) {
    it(`${name}: no money for a reader without finance access`, async () => {
      h.ctx = viewer();
      const out = await body<{ contracts: Row[] }>(await read(get(), at(id())));
      expectNoMoney(out.contracts.find((c) => c.id === onProject));
      expectNoMoney(out.contracts.find((c) => c.id === orgLevel));
      expect(figuresIn(out)).toEqual([]);
    });

    it(`${name}: control, finance sees the figures`, async () => {
      h.ctx = finance();
      const out = await body<{ contracts: Row[] }>(await read(get(), at(id())));
      expect(Number(out.contracts.find((c) => c.id === onProject)!.value)).toBe(VALUE);
    });

    it(`${name}: a contract on a project the reader cannot open is not listed`, async () => {
      h.ctx = viewer();
      const out = await body<{ contracts: Row[] }>(await read(get(), at(id())));
      expect(out.contracts.map((c) => c.id)).not.toContain(onHidden);
      // Control: a member of that project does get it (still without money).
      h.ctx = insider();
      const theirs = await body<{ contracts: Row[] }>(await read(get(), at(id())));
      expectNoMoney(theirs.contracts.find((c) => c.id === onHidden));
    });
  }
});

describe("contract PDF", () => {
  it("has no figures for a reader without finance access, and says Restricted", async () => {
    h.ctx = viewer();
    const res = await contractPdf(get(), at({ contractId: onProject }));
    expect(res.status).toBe(200);
    const text = pdfText(await res.arrayBuffer());
    expect(text).toContain("Project subaward");
    expect(text).toContain("Restricted");
    expect(text).not.toContain("918,273");
    expect(text).not.toContain("918273");
  });

  it("control: finance gets the value in the PDF", async () => {
    h.ctx = finance();
    const text = pdfText(await (await contractPdf(get(), at({ contractId: onProject }))).arrayBuffer());
    expect(text).toContain("918,273");
  });

  it("is not found on a project the reader cannot open", async () => {
    h.ctx = viewer();
    expect((await contractPdf(get(), at({ contractId: onHidden }))).status).toBe(404);
    h.ctx = insider();
    expect((await contractPdf(get(), at({ contractId: onHidden }))).status).toBe(200);
  });
});
