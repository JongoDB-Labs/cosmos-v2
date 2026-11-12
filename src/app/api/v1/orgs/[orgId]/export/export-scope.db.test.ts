// @vitest-environment node
//
// The org export (CSV per entity, and the JSON archive) hands out what its
// caller could read, not everything in the org.
//
// ORG_EXPORT is an administration bit, and a work role can grant it to someone
// without finance access. The export used to ignore that: it carried other
// people's private notes, every time entry's rate, revenues, expenses and
// contract values, and -- in the JSON archive -- each member's full user row,
// sign-in secrets included.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions, maskToDb } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
// Several exports in one file would trip the per-user export limit.
vi.mock("@/lib/rate-limit/guard", () => ({ checkRateLimit: () => null }));

import { GET as exportCsv } from "./csv/[entity]/route";
import { GET as exportJson } from "./json/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", owner = "", exporter = "";
const ids: Record<string, string> = {};

const FINANCE = Permission.FINANCE_READ | Permission.FINANCE_READ_PROJECT | Permission.ACCOUNTING_READ;
// An ADMIN's bits without finance: what a work role granting export might look like.
const NO_FINANCE = RolePermissions.ADMIN & ~FINANCE;
const as = (userId: string, permissions: bigint): AuthContext => ({
  userId, orgId, orgRole: "MEMBER", abacRules: [], permissions, basePermissions: permissions,
});
const withoutFinance = () => as(exporter, NO_FINANCE | Permission.ORG_EXPORT);
const withFinance = () => as(exporter, NO_FINANCE | Permission.ORG_EXPORT | Permission.FINANCE_READ);

beforeAll(async () => {
  owner = (await prisma.user.create({
    data: { email: `owner-${stamp}@export.test`, displayName: "Owner", passwordHash: "hash-not-for-export", mfaSecret: "mfa-not-for-export" },
  })).id;
  exporter = (await prisma.user.create({ data: { email: `exporter-${stamp}@export.test`, displayName: "Exporter" } })).id;
  orgId = (await prisma.organization.create({
    data: {
      name: `export ${stamp}`, slug: `export-${stamp}`,
      auth0OrgId: `idp-${stamp}-not-for-export`, dbConnectionId: `conn-${stamp}-not-for-export`,
      settings: { cql: { enabled: true } },
    },
  })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({
    data: {
      orgId, userId: exporter, role: "MEMBER", permissions: maskToDb(Permission.CRM_READ | Permission.NOTE_CREATE),
      abacRules: [{ effect: "deny", actions: ["ITEM_READ"], note: "rule-not-for-export" }],
    },
  });

  const note = (authorId: string, visibility: "PRIVATE" | "ORG", title: string) =>
    prisma.note.create({ data: { orgId, authorId, visibility, title, content: "body" } });
  ids.ownersPrivate = (await note(owner, "PRIVATE", "owner private")).id;
  ids.mine = (await note(exporter, "PRIVATE", "exporter private")).id;
  ids.shared = (await note(owner, "ORG", "org note")).id;

  const day = new Date("2026-10-08T00:00:00Z");
  ids.time = (await prisma.timeEntry.create({
    data: { orgId, userId: owner, date: day, hours: 3, rate: 175, status: "APPROVED", description: "rated" },
  })).id;
  ids.revenue = (await prisma.revenue.create({
    data: { orgId, amount: 9000, date: day, type: "RECURRING", description: "rev", createdById: owner },
  })).id;
  ids.expense = (await prisma.expense.create({
    data: { orgId, amount: 400, date: day, category: "Travel", createdById: owner },
  })).id;
  ids.contract = (await prisma.contract.create({
    data: { orgId, title: "Prime", value: 250000, fundedValue: 100000, status: "active" },
  })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, exporter] } } }).catch(() => undefined);
});

const at = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ orgId, ...extra }) }) as never;
const get = () => new NextRequest("http://localhost/x");
async function archive(): Promise<Record<string, unknown>> {
  const res = await exportJson(get(), at());
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}
async function csv(entity: string): Promise<{ status: number; text: string }> {
  const res = await exportCsv(get(), at({ entity }));
  return { status: res.status, text: await res.text() };
}
const rowsOf = (a: Record<string, unknown>, k: string) => (a[k] ?? []) as Record<string, unknown>[];

describe("the JSON archive", () => {
  it("without finance: no one else's private notes, no rates, no revenues or expenses, no contract values", async () => {
    h.ctx = withoutFinance();
    const a = await archive();
    expect(rowsOf(a, "notes").map((n) => n.id).sort()).toEqual([ids.mine, ids.shared].sort());
    expect(rowsOf(a, "timeEntries").find((t) => t.id === ids.time)?.rate).toBeNull();
    expect("revenues" in a).toBe(false);
    expect("expenses" in a).toBe(false);
    const contract = rowsOf(a, "contracts").find((c) => c.id === ids.contract);
    expect(contract?.title).toBe("Prime");
    expect(contract && "value" in contract).toBe(false);
    expect(contract && "fundedValue" in contract).toBe(false);
  });

  it("with finance: the money is there; other people's private notes still are not", async () => {
    h.ctx = withFinance();
    const a = await archive();
    expect(rowsOf(a, "notes").map((n) => n.id)).not.toContain(ids.ownersPrivate);
    expect(Number(rowsOf(a, "timeEntries").find((t) => t.id === ids.time)?.rate)).toBe(175);
    expect(rowsOf(a, "revenues").map((r) => r.id)).toEqual([ids.revenue]);
    expect(rowsOf(a, "expenses").map((r) => r.id)).toEqual([ids.expense]);
    expect(Number(rowsOf(a, "contracts").find((c) => c.id === ids.contract)?.value)).toBe(250000);
  });

  it("never carries a member's sign-in secrets, even for the owner", async () => {
    h.ctx = as(owner, RolePermissions.OWNER);
    const a = await archive();
    const users = rowsOf(a, "members").map((m) => m.user as Record<string, unknown>);
    expect(users.map((u) => u.id).sort()).toEqual([owner, exporter].sort());
    for (const u of users) {
      expect(u).not.toHaveProperty("passwordHash");
      expect(u).not.toHaveProperty("mfaSecret");
    }
    expect(JSON.stringify(a)).not.toMatch(/not-for-export/);
  });
});

describe("what the JSON archive says about the org and its people", () => {
  it("each member's user row is exactly the profile allowlist", async () => {
    h.ctx = as(owner, RolePermissions.OWNER);
    const users = rowsOf(await archive(), "members").map((m) => m.user as Record<string, unknown>);
    // Spelled out, not read from the select: a column added there must fail here.
    for (const u of users) {
      expect(Object.keys(u).sort()).toEqual(
        ["avatarUrl", "createdAt", "deactivatedAt", "displayName", "email", "id", "isBot", "lastActiveAt", "mfaEnabled"],
      );
    }
  });

  it("a member's permissions are permission names, with no raw mask and no policy rules", async () => {
    h.ctx = as(owner, RolePermissions.OWNER);
    const a = await archive();
    const member = rowsOf(a, "members").find((m) => m.userId === exporter)!;
    expect(Object.keys(member).sort()).toEqual(["id", "joinedAt", "permissions", "removedAt", "role", "user", "userId"]);
    expect([...(member.permissions as string[])].sort()).toEqual(["CRM_READ", "NOTE_CREATE"]);
    expect(JSON.stringify(a)).not.toContain("rule-not-for-export");
  });

  it("the organization row has no identity-provider or database link, and settings only for whoever may change them", async () => {
    h.ctx = as(owner, RolePermissions.OWNER);
    const a = await archive();
    const org = a.organization as Record<string, unknown>;
    expect(org.slug).toBe(`export-${stamp}`);
    expect(org).not.toHaveProperty("auth0OrgId");
    expect(org).not.toHaveProperty("dbConnectionId");
    expect(JSON.stringify(a)).not.toMatch(/not-for-export/);
    expect(org.settings).toEqual({ cql: { enabled: true } });

    h.ctx = withoutFinance();
    const theirs = (await archive()).organization as Record<string, unknown>;
    expect(theirs.slug).toBe(`export-${stamp}`);
    if ((NO_FINANCE & Permission.ORG_UPDATE) === 0n) expect(theirs).not.toHaveProperty("settings");
    h.ctx = as(exporter, (NO_FINANCE & ~Permission.ORG_UPDATE) | Permission.ORG_EXPORT);
    expect((await archive()).organization).not.toHaveProperty("settings");
  });
});

describe("every export is audited", () => {
  const last = () =>
    prisma.auditLog.findFirst({ where: { orgId, action: "org.data_exported" }, orderBy: { createdAt: "desc" } });

  it("the JSON archive records who took what, and no data", async () => {
    h.ctx = withoutFinance();
    await archive();
    const row = await last();
    expect(row?.userId).toBe(exporter);
    const meta = row?.metadata as { format?: string; entities?: string[]; includeFinance?: boolean };
    expect(meta.format).toBe("json");
    expect(meta.entities).toContain("notes");
    expect(meta.entities).not.toContain("revenues");
    expect(meta.includeFinance).toBe(false);
    expect(JSON.stringify(row?.metadata)).not.toContain("exporter private");
  });

  it("a CSV records the one entity", async () => {
    h.ctx = withFinance();
    expect((await csv("notes")).status).toBe(200);
    const meta = (await last())?.metadata as { format?: string; entities?: string[]; includeFinance?: boolean };
    expect(meta).toMatchObject({ format: "csv", entities: ["notes"], includeFinance: true });
  });
});

describe("a failed read fails the export", () => {
  it("JSON: says which entity failed, rather than exporting it as empty", async () => {
    h.ctx = as(owner, RolePermissions.OWNER);
    const spy = vi.spyOn(prisma.note, "findMany").mockRejectedValueOnce(new Error("connection reset"));
    try {
      const res = await exportJson(get(), at());
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/notes/);
    } finally {
      spy.mockRestore();
    }
  });

  it("CSV: the same", async () => {
    h.ctx = as(owner, RolePermissions.OWNER);
    const spy = vi.spyOn(prisma.note, "findMany").mockRejectedValueOnce(new Error("connection reset"));
    try {
      const { status, text } = await csv("notes");
      expect(status).toBe(500);
      expect(text).toMatch(/notes/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the CSV export", () => {
  it("notes: the exporter's own private note and shared ones, not the owner's private one", async () => {
    h.ctx = withoutFinance();
    const { status, text } = await csv("notes");
    expect(status).toBe(200);
    expect(text).toContain("exporter private");
    expect(text).toContain("org note");
    expect(text).not.toContain("owner private");
  });

  it("revenues and expenses need finance access", async () => {
    h.ctx = withoutFinance();
    expect((await csv("revenues")).status).toBe(403);
    expect((await csv("expenses")).status).toBe(403);
    h.ctx = withFinance();
    expect((await csv("revenues")).status).toBe(200);
    expect((await csv("expenses")).status).toBe(200);
  });

  it("contracts without finance: the columns are absent, not blank", async () => {
    h.ctx = withoutFinance();
    const header = (await csv("contracts")).text.split("\n")[0].split(",");
    expect(header).toContain("title");
    expect(header).not.toContain("value");
    expect(header).not.toContain("fundedValue");
    h.ctx = withFinance();
    expect((await csv("contracts")).text.split("\n")[0].split(",")).toContain("value");
  });

  it("time entries without finance: someone else's rate is blank", async () => {
    h.ctx = withoutFinance();
    const [header, row] = (await csv("time-entries")).text.split("\n");
    const cols = header.split(",");
    expect(row.split(",")[cols.indexOf("rate")]).toBe("");
  });
});

describe("contracts in either export follow the contract list's rule", () => {
  // CRM_READ on the contract's project decides, as on the contract list: a
  // project the exporter cannot open, or one where a rule denies them CRM data,
  // keeps its contracts out. A contract under no project is org-level CRM data.
  const OPEN = `open-contract-${stamp}`;
  const TEAM = `team-contract-${stamp}`;
  let openProject = "";
  beforeAll(async () => {
    const key = stamp.slice(0, 3).toUpperCase();
    const team = (await prisma.project.create({ data: { orgId, name: "T", key: `XT${key}`, teamScopedAccess: true } })).id;
    openProject = (await prisma.project.create({ data: { orgId, name: "O", key: `XO${key}` } })).id;
    await prisma.contract.create({ data: { orgId, projectId: team, title: TEAM } });
    await prisma.contract.create({ data: { orgId, projectId: openProject, title: OPEN } });
  });

  // A member who may export: not an admin, so team scoping applies to them.
  const member = (abacRules: AbacRule[] = []): AuthContext => {
    const permissions = RolePermissions.MEMBER | Permission.ORG_EXPORT;
    return { userId: exporter, orgId, orgRole: "MEMBER", abacRules, permissions, basePermissions: permissions };
  };
  const denyCrmOnOpen = (): AbacRule[] =>
    [{ effect: "deny", actions: ["CRM_READ"], conditions: [{ attr: "projectId", op: "eq", value: openProject }] }] as AbacRule[];
  const jsonTitles = async () => rowsOf(await archive(), "contracts").map((c) => c.title);
  const csvText = async () => {
    const r = await csv("contracts");
    expect(r.status).toBe(200);
    return r.text;
  };

  it("a contract on a project the exporter cannot open stays out of the JSON and the CSV", async () => {
    h.ctx = member();
    const json = await jsonTitles();
    // Positive controls: the open project's contract and the org-level one are there.
    expect(json).toEqual(expect.arrayContaining([OPEN, "Prime"]));
    expect(json).not.toContain(TEAM);
    const text = await csvText();
    expect(text).toContain(OPEN);
    expect(text).not.toContain(TEAM);
  });

  it("a rule denying CRM_READ on a project keeps its contracts out of both; the org-level one stays", async () => {
    h.ctx = member(denyCrmOnOpen());
    const json = await jsonTitles();
    expect(json).toContain("Prime");
    expect(json).not.toContain(OPEN);
    const text = await csvText();
    expect(text).toContain("Prime");
    expect(text).not.toContain(OPEN);
  });
});
