// @vitest-environment node
//
// Contract money on the program registers is finance data.
//
// CLIN ceiling and funding, CLIN burn (labour cost is approved hours times a
// person's cost rate), a change request's cost impact and a vendor contract's
// values were all returned on ANALYTICS_READ, which every VIEWER holds. On a
// CLIN one person charges, labour cost divided by hours IS that person's cost
// rate. The rule now: money needs FINANCE_READ, or FINANCE_READ_PROJECT on a
// project the reader is a member of. Without it the row still arrives, with
// the money fields left out (not zeroed), so a screen can say "restricted".
//
// Against a real database. Each refusal has a matching reader who does see the
// figure, so an assertion of absence can't pass on an empty response.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({
  ctx: null as unknown,
  uploads: [] as ArrayBuffer[],
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
// The SharePoint upload is a third-party call: stand in for Graph and keep the
// bytes, so the test can read what would have been written.
vi.mock("@/lib/integrations/microsoft-graph", () => ({
  graphUploadFile: async (_org: string, _path: string, body: ArrayBuffer) => {
    h.uploads.push(body);
    return { ok: true, data: { webUrl: "https://example.com/file.xlsx" } };
  },
}));

import { GET as listClins, POST as createClin } from "./clins/route";
import { PATCH as patchClin } from "./clins/[clinId]/route";
import { GET as evm } from "./clins/evm/route";
import { GET as listChanges } from "./changes/route";
import { PATCH as patchChange } from "./changes/[changeId]/route";
import { GET as listVendors } from "./vendors/route";
import { GET as pmActivity } from "./pm-activity/route";
import { GET as exportXlsx } from "./export/xlsx/route";
import { POST as sharepoint } from "./export/sharepoint/route";
import { listChanges as listChangesTool, updateChangeRequest } from "@/lib/ai/executors/pm-register";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", projectId = "", clinId = "", changeId = "", partnerId = "", contractId = "";
const users: Record<string, string> = {};

// Distinctive figures, so a search of the whole payload can't match by accident.
const CEILING = 987_650;
const FUNDED = 543_210;
const COST_RATE = 137; // per hour
const HOURS = 11;
const LABOUR = COST_RATE * HOURS; // 1507
const COST_IMPACT = 24_680;
const VENDOR_VALUE = 76_540;
const VENDOR_FUNDED = 65_430;
const VENDOR_INVOICED = 4_321;

const CLIN_MONEY = ["value", "fundedValue", "laborCost", "expenseCost", "burned", "remaining", "percentConsumed"];
const VENDOR_MONEY = ["value", "fundedValue", "invoicedValue", "remainingFunded", "pctBurnedFunded"];

const base = { orgRole: "MEMBER" as const, abacRules: [], basePermissions: 0n };
const READS = Permission.ORG_READ | Permission.PROJECT_READ | Permission.ANALYTICS_READ;
const as = (who: string, permissions: bigint): AuthContext => ({ ...base, userId: users[who], orgId, permissions });

/** A VIEWER's reads: ANALYTICS_READ and no finance bit. */
const viewer = () => as("viewer", READS);
/** Org-wide finance. */
const finance = () => as("finance", READS | Permission.FINANCE_READ);
/** Project-limited finance, on a project they are a member of. */
const memberFinance = () => as("memberFinance", READS | Permission.FINANCE_READ_PROJECT);
/** Project-limited finance, but not a member of this project. */
const outsiderFinance = () => as("outsiderFinance", READS | Permission.FINANCE_READ_PROJECT);

// `never`: each route types its own params (clinId, changeId, ...).
const at = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ orgId, projectId, ...extra }) }) as never;
const get = (url = "http://localhost/x") => new NextRequest(url);
const json = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

async function body<T = unknown>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

/** Every number in every cell of every sheet of a workbook. */
function numbersIn(buf: ArrayBuffer | Buffer): Set<number> {
  const wb = XLSX.read(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf, { type: "buffer" });
  const out = new Set<number>();
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    for (const [addr, cell] of Object.entries(sheet)) {
      if (addr.startsWith("!")) continue;
      const v = (cell as XLSX.CellObject).v;
      if (typeof v === "number") out.add(v);
    }
  }
  return out;
}

/** One sheet's cells: address → shown value and formula. */
function sheetCells(buf: ArrayBuffer | Buffer, sheetName: string): Map<string, { v: unknown; f?: string }> {
  // sheetStubs: an exported formula has no cached value (Excel recalculates on
  // open), and without stubs SheetJS drops such a cell as if it were empty.
  const wb = XLSX.read(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf, { type: "buffer", sheetStubs: true });
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`no sheet "${sheetName}" in ${wb.SheetNames.join(", ")}`);
  const out = new Map<string, { v: unknown; f?: string }>();
  for (const [addr, cell] of Object.entries(sheet)) {
    if (addr.startsWith("!")) continue;
    const c = cell as XLSX.CellObject;
    out.set(addr, { v: c.v, f: c.f });
  }
  return out;
}

beforeAll(async () => {
  for (const who of ["viewer", "finance", "memberFinance", "outsiderFinance", "worker"]) {
    users[who] = (await prisma.user.create({ data: { email: `${who}-${stamp}@money.test`, displayName: who } })).id;
  }
  orgId = (await prisma.organization.create({ data: { name: `money ${stamp}`, slug: `money-${stamp}` } })).id;
  const memberships: Record<string, string> = {};
  for (const [who, id] of Object.entries(users)) {
    memberships[who] = (await prisma.orgMember.create({ data: { orgId, userId: id, role: "MEMBER", permissions: "0" } })).id;
  }
  projectId = (await prisma.project.create({ data: { orgId, name: "Money", key: `MG${stamp.slice(0, 4).toUpperCase()}` } })).id;
  await prisma.projectMember.create({ data: { projectId, orgMemberId: memberships.memberFinance, role: "MEMBER" } });

  clinId = (await prisma.clin.create({
    data: { orgId, projectId, code: "0001", title: "Base", value: CEILING, fundedValue: FUNDED },
  })).id;
  // One person charges the CLIN, at their cost rate: the case where labour cost
  // gives the rate away.
  await prisma.employee.create({
    data: { orgId, userId: users.worker, costRate: COST_RATE, createdById: users.finance },
  });
  await prisma.timeEntry.create({
    data: {
      orgId, userId: users.worker, projectId, clinId, date: new Date("2026-10-05T00:00:00Z"),
      hours: HOURS, status: "APPROVED", description: "work",
    },
  });
  changeId = (await prisma.changeRequest.create({
    data: { orgId, projectId, code: `CR-${stamp}`, title: "Scope add", costImpact: COST_IMPACT, scheduleDaysImpact: 9 },
  })).id;
  partnerId = (await prisma.partner.create({ data: { orgId, name: "Sub Co", type: "subcontractor", status: "active" } })).id;
  contractId = (await prisma.contract.create({
    data: {
      orgId, projectId, partnerId, title: "Subcontract",
      value: VENDOR_VALUE, fundedValue: VENDOR_FUNDED, invoicedValue: VENDOR_INVOICED,
    },
  })).id;
  // The register's own change history: the old and new figures are money too.
  await prisma.activity.createMany({
    data: [
      { orgId, subjectType: "clin", subjectId: clinId, userId: users.finance, action: "updated", field: "value", oldValue: "900001", newValue: String(CEILING) },
      { orgId, subjectType: "clin", subjectId: clinId, userId: users.finance, action: "updated", field: "status", oldValue: "active", newValue: "on_hold" },
      { orgId, subjectType: "change", subjectId: changeId, userId: users.finance, action: "updated", field: "costImpact", oldValue: "100", newValue: String(COST_IMPACT) },
      { orgId, subjectType: "vendor", subjectId: contractId, userId: users.finance, action: "updated", field: "invoicedValue", oldValue: "0", newValue: String(VENDOR_INVOICED) },
    ],
  });
  await prisma.integration.create({
    data: {
      orgId, provider: "microsoft365", installedById: users.finance,
      config: { sharePoint: { siteId: "site", driveId: "drive" } },
    },
  });
});

afterAll(async () => {
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } }).catch(() => undefined);
});

describe("CLINs", () => {
  it("a VIEWER gets the CLIN without its money", async () => {
    h.ctx = viewer();
    const rows = await body<Record<string, unknown>[]>(await listClins(get(), at()));
    const row = rows.find((r) => r.id === clinId)!;
    expect(row).toMatchObject({ code: "0001", title: "Base" });
    for (const k of CLIN_MONEY) expect(row, k).not.toHaveProperty(k);
  });

  it("control: org-wide finance sees ceiling, funding and the labour cost", async () => {
    h.ctx = finance();
    const rows = await body<Record<string, unknown>[]>(await listClins(get(), at()));
    expect(rows.find((r) => r.id === clinId)).toMatchObject({
      value: CEILING, fundedValue: FUNDED, laborCost: LABOUR, burned: LABOUR,
    });
  });

  it("project finance sees it on a project they are on, and not on one they are not", async () => {
    h.ctx = memberFinance();
    const mine = await body<Record<string, unknown>[]>(await listClins(get(), at()));
    expect(mine.find((r) => r.id === clinId)).toMatchObject({ value: CEILING, laborCost: LABOUR });

    h.ctx = outsiderFinance();
    const theirs = await body<Record<string, unknown>[]>(await listClins(get(), at()));
    const row = theirs.find((r) => r.id === clinId)!;
    expect(row.code).toBe("0001");
    for (const k of CLIN_MONEY) expect(row, k).not.toHaveProperty(k);
  });

  it("EVM is all money: refused without finance, served with it", async () => {
    h.ctx = viewer();
    expect((await evm(get(), at())).status).toBe(403);
    h.ctx = finance();
    expect(await body(await evm(get(), at()))).toMatchObject({ ceiling: CEILING, burnedToDate: LABOUR });
  });

  it("a manager editing a CLIN's title is not handed back its money", async () => {
    // Writes stay on the project-manage gate; only what comes BACK is money.
    h.ctx = { ...viewer(), permissions: READS | Permission.PROJECT_UPDATE };
    const row = await body<Record<string, unknown>>(await patchClin(json("PATCH", { title: "Base (renamed)" }), at({ clinId })));
    expect(row.title).toBe("Base (renamed)");
    for (const k of ["value", "fundedValue"]) expect(row, k).not.toHaveProperty(k);

    h.ctx = { ...finance(), permissions: READS | Permission.PROJECT_UPDATE | Permission.FINANCE_READ };
    const back = await body<Record<string, unknown>>(await patchClin(json("PATCH", { title: "Base" }), at({ clinId })));
    expect(Number(back.value)).toBe(CEILING);
  });

  it("creating a CLIN without finance answers with the row, not the figures", async () => {
    h.ctx = { ...viewer(), permissions: READS | Permission.PROJECT_UPDATE };
    const res = await createClin(json("POST", { code: `X${stamp}`, title: "Extra", value: 5, fundedValue: 4 }), at());
    const row = await body<Record<string, unknown>>(res);
    expect(row.code).toBe(`X${stamp}`);
    expect(row).not.toHaveProperty("value");
    await prisma.clin.delete({ where: { id: String(row.id) } });
  });
});

describe("change requests", () => {
  it("a VIEWER sees the change and its schedule impact, not its cost", async () => {
    h.ctx = viewer();
    const rows = await body<Record<string, unknown>[]>(await listChanges(get(), at()));
    const row = rows.find((r) => r.id === changeId)!;
    expect(row).toMatchObject({ title: "Scope add", scheduleDaysImpact: 9 });
    expect(row).not.toHaveProperty("costImpact");
  });

  it("control: finance sees the cost impact", async () => {
    h.ctx = finance();
    const rows = await body<Record<string, unknown>[]>(await listChanges(get(), at()));
    expect(Number(rows.find((r) => r.id === changeId)!.costImpact)).toBe(COST_IMPACT);
  });

  it("a manager's edit doesn't return the cost impact either", async () => {
    h.ctx = { ...viewer(), permissions: READS | Permission.PROJECT_UPDATE };
    const row = await body<Record<string, unknown>>(await patchChange(json("PATCH", { notes: "n" }), at({ changeId })));
    expect(row.notes).toBe("n");
    expect(row).not.toHaveProperty("costImpact");
  });

  it("the assistant's change tools follow the same rule, and say the figure is withheld", async () => {
    const tool = (auth: AuthContext) => ({ orgId, userId: auth.userId, auth });
    const seen = (await listChangesTool({ projectId }, tool(viewer()))) as {
      changes: Record<string, unknown>[];
      costImpactWithheld?: string;
    };
    const mine = seen.changes.find((c) => c.id === changeId)!;
    expect(mine).toMatchObject({ scheduleDaysImpact: 9 });
    expect(mine).not.toHaveProperty("costImpact");
    expect(seen.costImpactWithheld).toMatch(/Finance/);

    const edited = (await updateChangeRequest(
      { projectId, changeId, title: "Scope add" },
      tool({ ...viewer(), permissions: READS | Permission.PROJECT_UPDATE }),
    )) as { changeRequest: Record<string, unknown> };
    expect(edited.changeRequest).not.toHaveProperty("costImpact");

    // Control: a finance reader gets the figure, and no withheld note.
    const shown = (await listChangesTool({ projectId }, tool(finance()))) as typeof seen;
    expect(Number(shown.changes.find((c) => c.id === changeId)!.costImpact)).toBe(COST_IMPACT);
    expect(shown.costImpactWithheld).toBeUndefined();
  });
});

describe("vendors", () => {
  it("a VIEWER sees the vendor and the subcontract, not its values", async () => {
    h.ctx = viewer();
    const rows = await body<Record<string, unknown>[]>(await listVendors(get(), at()));
    const row = rows.find((r) => r.id === contractId)!;
    expect(row).toMatchObject({ title: "Subcontract" });
    for (const k of VENDOR_MONEY) expect(row, k).not.toHaveProperty(k);
  });

  it("control: finance sees ceiling, funded and invoiced", async () => {
    h.ctx = finance();
    const rows = await body<Record<string, unknown>[]>(await listVendors(get(), at()));
    expect(rows.find((r) => r.id === contractId)).toMatchObject({
      value: VENDOR_VALUE, fundedValue: VENDOR_FUNDED, invoicedValue: VENDOR_INVOICED,
    });
  });
});

describe("a register's change history", () => {
  const activity = (subjectType: string, subjectId: string) =>
    pmActivity(get(`http://localhost/x?subjectType=${subjectType}&subjectId=${subjectId}`), at());

  it("says a money field changed without saying from what to what", async () => {
    h.ctx = viewer();
    const rows = await body<Record<string, unknown>[]>(await activity("clin", clinId));
    const money = rows.find((r) => r.field === "value")!;
    expect(money).not.toHaveProperty("oldValue");
    expect(money).not.toHaveProperty("newValue");
    // Not money: shown in full.
    expect(rows.find((r) => r.field === "status")).toMatchObject({ oldValue: "active", newValue: "on_hold" });

    const change = await body<Record<string, unknown>[]>(await activity("change", changeId));
    expect(change.find((r) => r.field === "costImpact")).not.toHaveProperty("newValue");
    const vendor = await body<Record<string, unknown>[]>(await activity("vendor", contractId));
    expect(vendor.find((r) => r.field === "invoicedValue")).not.toHaveProperty("newValue");
  });

  it("control: finance sees the figures in the history", async () => {
    h.ctx = finance();
    const rows = await body<Record<string, unknown>[]>(await activity("clin", clinId));
    expect(rows.find((r) => r.field === "value")).toMatchObject({ oldValue: "900001", newValue: String(CEILING) });
  });
});

describe("the Excel export", () => {
  // The handler's inferred type allows undefined (handleApiError's); it never is.
  const download = async (trackers: string, mode = "separate"): Promise<Response> =>
    (await exportXlsx(get(`http://localhost/x?trackers=${trackers}&mode=${mode}`), at())) as Response;

  it("writes the change log without cost impact for a VIEWER", async () => {
    h.ctx = viewer();
    const res = await download("changes");
    expect(res.status).toBe(200);
    const nums = numbersIn(await res.arrayBuffer());
    expect(nums.has(COST_IMPACT)).toBe(false);
    // The row itself is there: its schedule impact is in the sheet.
    expect(nums.has(9)).toBe(true);
  });

  it("says the cost impact is restricted, and so do the summary totals built on it", async () => {
    // Blank would read as "no cost impact", and a SUMIF over blanks reads as
    // a real $0. Both have to say what they are.
    h.ctx = viewer();
    const buf = await (await download("changes")).arrayBuffer();
    const log = sheetCells(buf, "Change Log");
    expect(log.get("I4")?.v).toBe("Restricted");
    const summary = [...sheetCells(buf, "Change Summary").values()];
    expect(summary.some((c) => c.v === "Restricted")).toBe(true);
    expect(summary.filter((c) => c.f && /'Change Log'!I/.test(c.f))).toEqual([]);

    h.ctx = finance();
    const shown = await (await download("changes")).arrayBuffer();
    expect(sheetCells(shown, "Change Log").get("I4")?.v).toBe(COST_IMPACT);
    // Control: finance's summary still totals the column.
    expect([...sheetCells(shown, "Change Summary").values()].some((c) => c.f && /'Change Log'!I/.test(c.f))).toBe(true);
  });

  it("the vendor summary says restricted rather than totalling nothing", async () => {
    h.ctx = viewer();
    const summary = sheetCells(await (await download("vendors")).arrayBuffer(), "Summary Dashboard");
    expect(summary.get("B6")?.v).toBe("Restricted");
    h.ctx = finance();
    const shown = sheetCells(await (await download("vendors")).arrayBuffer(), "Summary Dashboard");
    expect(shown.get("B6")?.f).toMatch(/Vendor Register/);
  });

  it("the vendor Mod Log and Invoice Log say Restricted rather than leaving the money blank", async () => {
    h.ctx = viewer();
    const buf = await (await download("vendors")).arrayBuffer();
    const mod = sheetCells(buf, "Mod Log");
    expect(mod.get("A4")?.v).toBe("V-001");
    expect(mod.get("J4")?.v).toBe("Restricted");
    expect(mod.get("M4")?.v).toBe("Restricted");
    expect([...sheetCells(buf, "Invoice Log").values()].some((c) => c.v === "Restricted")).toBe(true);

    // Control: finance's logs carry the figures.
    h.ctx = finance();
    const shown = await (await download("vendors")).arrayBuffer();
    expect(sheetCells(shown, "Mod Log").get("J4")?.v).toBe(VENDOR_VALUE);
    expect([...sheetCells(shown, "Invoice Log").values()].some((c) => c.v === VENDOR_INVOICED)).toBe(true);
  });

  it("control: finance's change log carries the cost impact", async () => {
    h.ctx = finance();
    const nums = numbersIn(await (await download("changes")).arrayBuffer());
    expect(nums.has(COST_IMPACT)).toBe(true);
  });

  it("writes vendors without their values for a VIEWER, with them for finance", async () => {
    h.ctx = viewer();
    const withheld = numbersIn(await (await download("vendors")).arrayBuffer());
    for (const n of [VENDOR_VALUE, VENDOR_FUNDED, VENDOR_INVOICED]) expect(withheld.has(n), String(n)).toBe(false);
    h.ctx = finance();
    const shown = numbersIn(await (await download("vendors")).arrayBuffer());
    expect(shown.has(VENDOR_VALUE)).toBe(true);
  });

  it("refuses the burn workbook alone without finance; finance gets the figures", async () => {
    h.ctx = viewer();
    expect((await download("burn")).status).toBe(403);
    h.ctx = finance();
    const nums = numbersIn(await (await download("burn")).arrayBuffer());
    expect(nums.has(CEILING)).toBe(true);
  });

  it("the combined workbook carries no CLIN, change or vendor money for a VIEWER", async () => {
    h.ctx = viewer();
    const res = await download("changes,vendors,burn", "combined");
    expect(res.status).toBe(200);
    const nums = numbersIn(await res.arrayBuffer());
    for (const n of [CEILING, FUNDED, LABOUR, COST_IMPACT, VENDOR_VALUE, VENDOR_FUNDED, VENDOR_INVOICED]) {
      expect(nums.has(n), String(n)).toBe(false);
    }
  });
});

describe("mirroring to SharePoint", () => {
  it("is a write to the org's store, so a VIEWER can't do it", async () => {
    h.uploads = [];
    h.ctx = viewer();
    expect((await sharepoint(json("POST", {}), at())).status).toBe(403);
    expect(h.uploads).toHaveLength(0);
  });

  it("an exporter without finance mirrors a workbook with no money in it", async () => {
    h.uploads = [];
    h.ctx = { ...viewer(), permissions: READS | Permission.ORG_EXPORT };
    expect((await sharepoint(json("POST", {}), at())).status).toBe(200);
    const nums = numbersIn(h.uploads[0]);
    for (const n of [CEILING, FUNDED, LABOUR, COST_IMPACT, VENDOR_VALUE, VENDOR_FUNDED, VENDOR_INVOICED]) {
      expect(nums.has(n), String(n)).toBe(false);
    }
  });

  it("control: an exporter with finance mirrors the figures", async () => {
    h.uploads = [];
    h.ctx = { ...finance(), permissions: READS | Permission.ORG_EXPORT | Permission.FINANCE_READ };
    expect((await sharepoint(json("POST", {}), at())).status).toBe(200);
    const nums = numbersIn(h.uploads[0]);
    expect(nums.has(CEILING)).toBe(true);
    expect(nums.has(COST_IMPACT)).toBe(true);
    expect(nums.has(VENDOR_VALUE)).toBe(true);
  });
});
