// @vitest-environment node
//
// A project's contracts are CRM data, in its exports as on the contract list.
//
// The contract list and a contract by id ask CRM_READ on the contract's
// project (lib/crm/contract-scope.ts). The project's workbooks read the same
// rows with only the org and project: the vendor register (partner, CAGE, NDA,
// point of contact), and each deliverable's contract by title, which can be an
// org-level contract the vendor register never lists. And linking a
// deliverable to a contract answered "not found" or "belongs to a different
// project", which told the caller the id was a real contract somewhere.
//
// Against a real database. Each refusal has a reader with CRM_READ beside it,
// so an absence can't pass on an empty workbook.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";

const h = vi.hoisted(() => ({ ctx: null as unknown, uploads: [] as ArrayBuffer[] }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
// The SharePoint upload is a third-party call: keep the bytes instead.
vi.mock("@/lib/integrations/microsoft-graph", () => ({
  graphUploadFile: async (_org: string, _path: string, body: ArrayBuffer) => {
    h.uploads.push(body);
    return { ok: true, data: { webUrl: "https://example.com/file.xlsx" } };
  },
}));

import { GET as exportXlsx } from "./export/xlsx/route";
import { POST as sharepoint } from "./export/sharepoint/route";
import { POST as createDeliverable } from "./deliverables/route";
import { PATCH as patchDeliverable } from "./deliverables/[deliverableId]/route";
import { buildPopulatedTemplate } from "@/lib/pm/template-export";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", projectId = "", otherProjectId = "", userId = "";
let vendorContract = "", orgContract = "", otherContract = "", linkedDeliverable = "";

// Distinctive text, so a search of the whole workbook can't match by accident.
const VENDOR_TITLE = `Subcontract ${stamp}`;
const PARTNER = `Partner ${stamp}`;
const ORG_TITLE = `Prime ${stamp}`;
const DELIVERABLE = `Report ${stamp}`;

// Finance too, so the money gate is not what removes anything here.
const READS =
  Permission.ORG_READ | Permission.PROJECT_READ | Permission.ANALYTICS_READ |
  Permission.FINANCE_READ | Permission.ORG_EXPORT | Permission.PROJECT_UPDATE;
const ctxOf = (permissions: bigint, abacRules: AbacRule[] = []): AuthContext => ({
  userId, orgId, orgRole: "MEMBER", abacRules, permissions, basePermissions: permissions,
});
/** Everything the workbook needs, and no CRM_READ. */
const noCrm = () => ctxOf(READS);
/** CRM_READ, but a policy denies it on this project. */
const deniedHere = () =>
  ctxOf(READS | Permission.CRM_READ, [
    { effect: "deny", actions: ["CRM_READ"], conditions: [{ attr: "projectId", op: "eq", value: projectId }] },
  ] as AbacRule[]);
/** The control: CRM_READ on this project. */
const crm = () => ctxOf(READS | Permission.CRM_READ);

const at = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ orgId, projectId, ...extra }) }) as never;
const get = (url: string) => new NextRequest(url);
const json = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

/** Every string in every cell of every sheet, and the sheet names. */
function textOf(buf: ArrayBuffer | Buffer): { sheets: string[]; cells: string[] } {
  const wb = XLSX.read(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf, { type: "buffer" });
  const cells: string[] = [];
  for (const name of wb.SheetNames) {
    for (const [addr, cell] of Object.entries(wb.Sheets[name])) {
      if (!addr.startsWith("!") && typeof (cell as XLSX.CellObject).v === "string") cells.push((cell as XLSX.CellObject).v as string);
    }
  }
  return { sheets: wb.SheetNames, cells };
}

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `crm-${stamp}@contract-gate.test`, displayName: "Reader" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `contract gate ${stamp}`, slug: `contract-gate-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } });
  const key = stamp.slice(0, 3).toUpperCase();
  projectId = (await prisma.project.create({ data: { orgId, name: "Gate", key: `CG${key}` } })).id;
  otherProjectId = (await prisma.project.create({ data: { orgId, name: "Other", key: `CO${key}` } })).id;
  const partnerId = (await prisma.partner.create({ data: { orgId, name: PARTNER, type: "subcontractor", status: "active" } })).id;
  vendorContract = (await prisma.contract.create({ data: { orgId, projectId, partnerId, title: VENDOR_TITLE, value: 1000 } })).id;
  orgContract = (await prisma.contract.create({ data: { orgId, title: ORG_TITLE } })).id;
  otherContract = (await prisma.contract.create({ data: { orgId, projectId: otherProjectId, title: "Elsewhere" } })).id;
  linkedDeliverable = (await prisma.deliverable.create({
    data: { orgId, projectId, contractId: orgContract, code: `CDRL-${stamp}`, title: DELIVERABLE },
  })).id;
  await prisma.integration.create({
    data: { orgId, provider: "microsoft365", installedById: userId, config: { sharePoint: { siteId: "site", driveId: "drive" } } },
  });
});

afterAll(async () => {
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

describe("the project workbook (mirrored to SharePoint)", () => {
  async function mirrored(ctx: AuthContext) {
    h.uploads = [];
    h.ctx = ctx;
    const res = await sharepoint(json("POST", {}), at());
    expect(res.status, await res.clone().text()).toBe(200);
    expect(h.uploads).toHaveLength(1);
    return textOf(h.uploads[0]);
  }

  it("control: with CRM_READ it carries the vendor register and each deliverable's contract", async () => {
    const { sheets, cells } = await mirrored(crm());
    expect(sheets).toContain("Vendors");
    expect(cells).toEqual(expect.arrayContaining([VENDOR_TITLE, PARTNER, ORG_TITLE, DELIVERABLE, "Contract"]));
  });

  it.each([
    ["without CRM_READ", noCrm],
    ["under a policy denying CRM_READ on the project", deniedHere],
  ])("%s: no vendor register, no contract column, no contract or partner name anywhere", async (_why, who) => {
    const { sheets, cells } = await mirrored(who());
    expect(sheets).not.toContain("Vendors");
    // The rest of the workbook is still there: the deliverable, without its contract.
    expect(sheets).toContain("Deliverables");
    expect(cells).toContain(DELIVERABLE);
    expect(cells).not.toContain("Contract");
    for (const t of [VENDOR_TITLE, PARTNER, ORG_TITLE]) expect(cells, t).not.toContain(t);
  });
});

describe("the tracker export", () => {
  const download = async (trackers: string, mode = "separate") =>
    (await exportXlsx(get(`http://localhost/x?trackers=${trackers}&mode=${mode}`), at())) as Response;

  // The vendor tracker names the vendor by its partner (company name); the
  // template has no column for the contract's own title.
  it("control: with CRM_READ the vendor tracker names the vendor", async () => {
    h.ctx = crm();
    const res = await download("vendors");
    expect(res.status).toBe(200);
    expect(textOf(await res.arrayBuffer()).cells).toContain(PARTNER);
  });

  it.each([
    ["without CRM_READ", noCrm],
    ["under a policy denying CRM_READ on the project", deniedHere],
  ])("%s: the vendor tracker alone is refused, not an empty file", async (_why, who) => {
    h.ctx = who();
    expect((await download("vendors")).status).toBe(403);
  });

  it("without CRM_READ a selection drops the vendor tracker and keeps the rest", async () => {
    h.ctx = noCrm();
    const res = await download("vendors,deliverables");
    expect(res.status).toBe(200);
    // A single tracker left needs no zip: it is the deliverables file itself.
    expect(res.headers.get("Content-Disposition")).toMatch(/-deliverables\.xlsx/);
    const { cells } = textOf(await res.arrayBuffer());
    expect(cells).toContain(DELIVERABLE);
    expect(cells).not.toContain(PARTNER);

    // Control: with CRM_READ the same selection is a zip of both.
    h.ctx = crm();
    const both = await download("vendors,deliverables");
    const zip = await JSZip.loadAsync(await both.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual([`CG${stamp.slice(0, 3).toUpperCase()}-deliverables.xlsx`, `CG${stamp.slice(0, 3).toUpperCase()}-vendors.xlsx`]);
  });

  it("the vendor template itself refuses to build without contracts, whatever the caller asked", async () => {
    // The backstop under the route's selection, as burn has for money.
    await expect(
      buildPopulatedTemplate("vendors", orgId, projectId, "KEY", { includeMoney: true, includeContracts: false }),
    ).rejects.toThrow(/CRM access/);
    // Control: the same call with contracts builds the file.
    const built = await buildPopulatedTemplate("vendors", orgId, projectId, "KEY", { includeMoney: true, includeContracts: true });
    expect(textOf(built.buffer).cells).toContain(PARTNER);
  });

  it("the combined workbook has no vendor register without CRM_READ", async () => {
    h.ctx = noCrm();
    const withheld = textOf(await (await download("vendors,deliverables", "combined")).arrayBuffer());
    expect(withheld.cells).not.toContain(PARTNER);
    expect(withheld.cells).toContain(DELIVERABLE);
    h.ctx = crm();
    const shown = textOf(await (await download("vendors,deliverables", "combined")).arrayBuffer());
    expect(shown.cells).toContain(PARTNER);
  });
});

describe("linking a deliverable to a contract", () => {
  const create = (contractId: string) => createDeliverable(json("POST", { title: `Linked ${stamp}`, contractId }), at());

  it("a contract on a different project is 'not found', the same as one that doesn't exist", async () => {
    h.ctx = crm();
    const elsewhere = await create(otherContract);
    const missing = await create("00000000-0000-4000-8000-000000000000");
    expect(elsewhere.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await elsewhere.text()).toBe(await missing.text());
  });

  it.each([
    ["without CRM_READ", noCrm, () => orgContract],
    ["without CRM_READ, this project's own contract", noCrm, () => vendorContract],
    ["under a policy denying CRM_READ on the project", deniedHere, () => vendorContract],
  ])("%s: a contract the caller may not read is 'not found'", async (_why, who, contract) => {
    h.ctx = who();
    expect((await create(contract())).status).toBe(404);
  });

  it("control: a reader of the contract links it, on this project or at org level", async () => {
    h.ctx = crm();
    expect((await create(vendorContract)).status).toBe(200);
    expect((await create(orgContract)).status).toBe(200);
  });

  it("an edit that leaves the contract as it was is not refused for it", async () => {
    // GET, change a field, PATCH it all back: the contract id rides along
    // unchanged and is not a new link.
    h.ctx = noCrm();
    const res = await patchDeliverable(
      json("PATCH", { notes: "edited", contractId: orgContract }),
      at({ deliverableId: linkedDeliverable }),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    // Moving it to another contract is a new link, and is refused.
    expect((await patchDeliverable(
      json("PATCH", { contractId: vendorContract }),
      at({ deliverableId: linkedDeliverable }),
    )).status).toBe(404);
  });
});
