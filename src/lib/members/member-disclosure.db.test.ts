// @vitest-environment node
//
// Every route that lists org members applies two rules to an API key: emails
// only with `members:read`, and only the people inside a project-scoped key's
// roster (`scopedRosterUserIds`). A browser session sees both in full. Driven
// through the real routes against a real database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";

const h = vi.hoisted(() => ({ ctx: null as unknown, pdf: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/pdf/audit-log", () => ({
  generateAuditLogPdf: async (input: unknown) => {
    h.pdf = input;
    return Buffer.from("%PDF-fake");
  },
}));

import { GET as projectMembers } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/members/route";
import { GET as projectTeams } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/teams/route";
import { GET as capacity } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/capacity/route";
import { GET as cqlSuggest } from "@/app/api/v1/orgs/[orgId]/cql/suggest/route";
import { GET as auditExport } from "@/app/api/v1/orgs/[orgId]/audit-logs/export/route";
import { POST as cqlValidate } from "@/app/api/v1/orgs/[orgId]/cql/validate/route";
import { GET as savedViewGet } from "@/app/api/v1/orgs/[orgId]/saved-views/[viewId]/route";
import { CQL_VERSION } from "@/lib/query/ast";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", pId = "", qId = "", intervalId = "", otherIntervalId = "";
const u = { caller: "", inP: "", onlyQ: "" };
const email = (k: keyof typeof u) => `${k.toLowerCase()}-${stamp}@disclose.test`;

function session(): AuthContext {
  const permissions = RolePermissions.OWNER;
  return { userId: u.caller, orgId, orgRole: "OWNER", abacRules: [], basePermissions: permissions, permissions };
}
function key(scopes: string[], projectScope?: string[]): AuthContext {
  const s = session();
  return { ...s, isApiKey: true, scopes, permissions: s.permissions & scopeMask(scopes), ...(projectScope && { projectScope }) };
}

const req = (path: string) => new NextRequest(`http://localhost/api/v1/orgs/${orgId}${path}`);
async function json(res: Response): Promise<unknown> {
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data ?? body;
}
const emailsIn = (v: unknown) => JSON.stringify(v).match(/[a-z0-9.-]+@disclose\.test/g) ?? [];

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `disc ${stamp}`, slug: `disc-${stamp}` } })).id;
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    u[k] = (await prisma.user.create({ data: { email: email(k), displayName: `${k} person` } })).id;
  }
  const om: Record<string, string> = {};
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    om[k] = (await prisma.orgMember.create({ data: { orgId, userId: u[k], role: k === "caller" ? "OWNER" : "MEMBER", permissions: "0" } })).id;
  }
  pId = (await prisma.project.create({ data: { orgId, name: "P", key: `P${stamp}`.toUpperCase().slice(0, 8) } })).id;
  qId = (await prisma.project.create({ data: { orgId, name: "Q", key: `Q${stamp}`.toUpperCase().slice(0, 8) } })).id;
  const pmP = await prisma.projectMember.create({ data: { projectId: pId, orgMemberId: om.inP } });
  await prisma.projectMember.create({ data: { projectId: qId, orgMemberId: om.onlyQ } });
  const team = await prisma.team.create({ data: { orgId, projectId: pId, name: "Team P" } });
  await prisma.teamMember.create({ data: { teamId: team.id, projectMemberId: pmP.id } });
  const sprint = { orgId, number: 1, name: "S1", startDate: new Date("2026-01-01"), endDate: new Date("2026-01-14") };
  intervalId = (await prisma.interval.create({ data: { ...sprint, projectId: pId } })).id;
  otherIntervalId = (await prisma.interval.create({ data: { ...sprint, projectId: qId } })).id;
  // Capacity may name anyone in the org, including someone outside the project.
  for (const userId of [u.inP, u.onlyQ]) await prisma.intervalCapacity.create({ data: { intervalId, userId, capacity: 5 } });
  await prisma.intervalCapacity.create({ data: { intervalId: otherIntervalId, userId: u.onlyQ, capacity: 3 } });
  for (const userId of [u.inP, u.onlyQ]) {
    await prisma.auditLog.create({ data: { orgId, userId, action: "test.action", entity: "test" } });
  }
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.intervalCapacity.deleteMany({ where: { intervalId: { in: [intervalId, otherIntervalId] } } });
  await prisma.interval.deleteMany({ where: { orgId } });
  await prisma.team.deleteMany({ where: { orgId } });
  await prisma.projectMember.deleteMany({ where: { project: { orgId } } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } });
});

describe("project members GET", () => {
  const call = async (ctx: AuthContext) => {
    h.ctx = ctx;
    return json(await projectMembers(req(`/projects/${pId}/members`), { params: Promise.resolve({ orgId, projectId: pId }) }));
  };
  it("sends emails to a session and to a key with members:read, not to a read key", async () => {
    expect(emailsIn(await call(session()))).toEqual([email("inP")]);
    expect(emailsIn(await call(key(["read", "members:read"])))).toEqual([email("inP")]);
    const rows = (await call(key(["read"]))) as Array<{ userId: string; email?: string }>;
    expect(rows.map((r) => r.userId)).toEqual([u.inP]);
    expect(emailsIn(rows)).toEqual([]);
  });
});

describe("project teams GET", () => {
  const call = async (ctx: AuthContext) => {
    h.ctx = ctx;
    return json(await projectTeams(req(`/projects/${pId}/teams`), { params: Promise.resolve({ orgId, projectId: pId }) }));
  };
  it("sends emails to a session and to a key with members:read, not to a read key", async () => {
    expect(emailsIn(await call(session()))).toEqual([email("inP")]);
    expect(emailsIn(await call(key(["read", "members:read"])))).toEqual([email("inP")]);
    const teams = (await call(key(["read"]))) as Array<{ members: Array<{ userId: string }> }>;
    expect(teams[0].members.map((m) => m.userId)).toEqual([u.inP]);
    expect(emailsIn(teams)).toEqual([]);
  });
});

describe("sprint capacity GET", () => {
  const call = async (ctx: AuthContext, interval = intervalId) => {
    h.ctx = ctx;
    return json(await capacity(req(`/projects/${pId}/intervals/${interval}/capacity`), { params: Promise.resolve({ orgId, projectId: pId, intervalId: interval }) }));
  };
  const users = (rows: unknown) => (rows as Array<{ userId: string }>).map((r) => r.userId).sort();

  it("sends emails only with members:read", async () => {
    expect(emailsIn(await call(session())).sort()).toEqual([email("inP"), email("onlyQ")].sort());
    expect(emailsIn(await call(key(["read", "members:read"]))).sort()).toEqual([email("inP"), email("onlyQ")].sort());
    const rows = await call(key(["read"]));
    expect(users(rows)).toEqual([u.inP, u.onlyQ].sort());
    expect(emailsIn(rows)).toEqual([]);
  });

  it("lists only the people inside a project-scoped key's roster", async () => {
    expect(users(await call(key(["read", "members:read"], [pId])))).toEqual([u.inP]);
  });

  it("answers only for a sprint of the project in the path", async () => {
    h.ctx = session();
    const res = await capacity(req(`/projects/${pId}/intervals/${otherIntervalId}/capacity`), {
      params: Promise.resolve({ orgId, projectId: pId, intervalId: otherIntervalId }),
    });
    // Refused, or answered with nothing: either way not the other sprint's rows.
    const rows: unknown = res.status === 200 ? await res.json() : [];
    expect(Array.isArray(rows)).toBe(true);
    expect(users(rows)).toEqual([]);
  });
});

describe("cql/suggest for people", () => {
  const call = async (ctx: AuthContext, prefix: string) => {
    h.ctx = ctx;
    const body = (await json(await cqlSuggest(req(`/cql/suggest?field=assignee&prefix=${encodeURIComponent(prefix)}&limit=50`), { params: Promise.resolve({ orgId }) }))) as { items: Array<{ label: string; detail?: string; kind: string }> };
    return body.items.filter((i) => i.kind === "user");
  };

  it("searches and shows emails only with members:read", async () => {
    // Prefix-searching by address is itself a way to learn one.
    expect((await call(session(), `onlyq-${stamp}`)).map((i) => i.label)).toEqual(["onlyQ person"]);
    expect((await call(key(["read", "members:read"]), `onlyq-${stamp}`)).map((i) => i.label)).toEqual(["onlyQ person"]);
    expect(await call(key(["read"]), `onlyq-${stamp}`)).toEqual([]);
    const byName = await call(key(["read"]), "onlyQ person");
    expect(byName.map((i) => i.label)).toEqual(["onlyQ person"]);
    expect(emailsIn(byName)).toEqual([]);
  });

  it("lists only the people inside a project-scoped key's roster", async () => {
    const labels = (await call(key(["read", "members:read"], [pId]), "person")).map((i) => i.label);
    expect(labels).toEqual(["inP person"]);
    const all = (await call(session(), "person")).map((i) => i.label).sort();
    expect(all).toEqual(["caller person", "inP person", "onlyQ person"]);
  });
});

describe("audit-log PDF export", () => {
  const call = async (ctx: AuthContext) => {
    h.ctx = ctx;
    h.pdf = null;
    const res = await auditExport(req(`/audit-logs/export?format=pdf&action=test.action`), { params: Promise.resolve({ orgId }) });
    expect(res.status).toBe(200);
    return h.pdf as { exportedBy: string; rows: Array<{ userId: string; userLabel: string | null }> };
  };
  const labels = (pdf: { rows: Array<{ userId: string; userLabel: string | null }> }) =>
    Object.fromEntries(pdf.rows.map((r) => [r.userId, r.userLabel]));

  it("labels people by email only for a session or a key with members:read", async () => {
    await prisma.user.update({ where: { id: u.onlyQ }, data: { displayName: "" } });
    try {
      const s = await call(session());
      expect(labels(s)[u.onlyQ]).toBe(email("onlyQ"));
      expect(s.exportedBy).toBe(email("caller"));

      const k = await call(key(["audit:read"]));
      expect(labels(k)[u.onlyQ]).not.toContain("@");
      expect(labels(k)[u.inP]).toBe("inP person");
      expect(k.exportedBy).not.toContain("@");
    } finally {
      await prisma.user.update({ where: { id: u.onlyQ }, data: { displayName: "onlyQ person" } });
    }
  });

  it("is refused to a project-scoped key, so it names nobody outside the key's roster", async () => {
    // Audit rows cover the whole org, so a key limited to some projects can't
    // export them at all (audit-logs/key-scope.db.test.ts covers every door).
    h.ctx = key(["read", "audit:read", "members:read"], [pId]);
    h.pdf = null;
    const res = await auditExport(req(`/audit-logs/export?format=pdf&action=test.action`), { params: Promise.resolve({ orgId }) });
    expect(res.status).toBe(403);
    expect(h.pdf).toBeNull();
  });
});

describe("CQL naming people", () => {
  // Two people with one name, one in each project: only twinP is in a
  // P-scoped key's roster.
  const twin = { P: "", Q: "" };
  const twinName = `Twin ${stamp}`;
  const twinEmail = (k: "P" | "Q") => `twin${k.toLowerCase()}-${stamp}@disclose.test`;
  let viewId = "";

  beforeAll(async () => {
    for (const k of ["P", "Q"] as const) {
      twin[k] = (await prisma.user.create({ data: { email: twinEmail(k), displayName: twinName } })).id;
      const om = await prisma.orgMember.create({ data: { orgId, userId: twin[k], role: "MEMBER", permissions: "0" } });
      await prisma.projectMember.create({ data: { projectId: k === "P" ? pId : qId, orgMemberId: om.id } });
    }
    const query = {
      v: CQL_VERSION,
      where: {
        op: "in",
        field: { kind: "sys", id: "assignee" },
        values: [
          { t: "ref", entity: "user", id: twin.P },
          { t: "ref", entity: "user", id: twin.Q },
        ],
      },
    };
    viewId = (await prisma.savedView.create({ data: { orgId, ownerId: u.caller, name: `twins ${stamp}`, query } })).id;
  });

  afterAll(async () => {
    await prisma.savedView.deleteMany({ where: { id: viewId } });
    await prisma.projectMember.deleteMany({ where: { orgMember: { userId: { in: Object.values(twin) } } } });
    await prismaUnfiltered.orgMember.deleteMany({ where: { userId: { in: Object.values(twin) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(twin) } } });
  });

  type Validated = {
    valid: boolean;
    query?: unknown;
    diagnostics: Array<{ code: string; fixes?: Array<{ label: string; replace: { insert: string } }> }>;
  };
  const validate = async (ctx: AuthContext, cql: string): Promise<Validated> => {
    h.ctx = ctx;
    const res = await cqlValidate(
      new NextRequest(`http://localhost/api/v1/orgs/${orgId}/cql/validate`, { method: "POST", body: JSON.stringify({ cql, mode: "strict" }) }),
      { params: Promise.resolve({ orgId }) },
    );
    return (await json(res)) as Validated;
  };

  it("matches typed text against addresses only with members:read", async () => {
    const byEmail = `assignee = "${email("onlyQ")}"`;
    expect((await validate(session(), byEmail)).valid).toBe(true);
    expect((await validate(key(["read", "members:read"]), byEmail)).valid).toBe(true);
    // Otherwise an address in, a person out: who is a member, one guess at a time.
    const k = await validate(key(["read"]), byEmail);
    expect(k.valid).toBe(false);
    expect(k.diagnostics[0].code).toBe("CQL_UNKNOWN_VALUE");
    // Nor by naming the person too, which loads their row: the address must
    // not then confirm whose it is.
    const both = await validate(key(["read"]), `assignee in ("onlyQ person", "${email("onlyQ")}")`);
    expect(both.diagnostics.map((d) => d.code)).toEqual(["CQL_UNKNOWN_VALUE"]);
    expect((await validate(session(), `assignee in ("onlyQ person", "${email("onlyQ")}")`)).valid).toBe(true);
  });

  it("offers same-name people by email only with members:read, and by id otherwise", async () => {
    const s = await validate(session(), `assignee = "${twinName}"`);
    expect(s.diagnostics[0].code).toBe("CQL_AMBIGUOUS_VALUE");
    expect([...new Set(emailsIn(s))].sort()).toEqual([twinEmail("P"), twinEmail("Q")].sort());

    const k = await validate(key(["read"]), `assignee = "${twinName}"`);
    expect(k.diagnostics[0].code).toBe("CQL_AMBIGUOUS_VALUE");
    expect(emailsIn(k)).toEqual([]);
    expect(k.diagnostics[0].fixes!.map((f) => f.replace.insert).sort()).toEqual([`"${twin.P}"`, `"${twin.Q}"`].sort());
  });

  it("names only the people inside a project-scoped key's roster", async () => {
    const scoped = key(["read", "members:read"], [pId]);
    const twins = await validate(scoped, `assignee = "${twinName}"`);
    expect(twins.valid).toBe(true);
    expect(emailsIn(twins)).toEqual([]);
    expect(JSON.stringify(twins.query)).toContain(twin.P);
    expect(JSON.stringify(twins.query)).not.toContain(twin.Q);
    expect((await validate(scoped, `assignee = "onlyQ person"`)).diagnostics[0].code).toBe("CQL_UNKNOWN_VALUE");
    expect((await validate(scoped, `assignee = "inP person"`)).valid).toBe(true);
  });

  it("prints a saved filter's same-name people by email only with members:read", async () => {
    const view = async (ctx: AuthContext) => {
      h.ctx = ctx;
      return (await json(await savedViewGet(req(`/saved-views/${viewId}`), { params: Promise.resolve({ orgId, viewId }) }))) as { cql: string };
    };
    const s = await view(session());
    expect(emailsIn(s.cql).sort()).toEqual([twinEmail("P"), twinEmail("Q")].sort());
    expect(emailsIn((await view(key(["read", "members:read"]))).cql).sort()).toEqual([twinEmail("P"), twinEmail("Q")].sort());

    const k = await view(key(["read"]));
    expect(emailsIn(k)).toEqual([]);
    expect(k.cql).toContain(twin.P);
    expect(k.cql).toContain(twin.Q);

    // In a P-scoped key's roster twinP is the only one by that name.
    const scoped = await view(key(["read", "members:read"], [pId]));
    expect(emailsIn(scoped)).toEqual([]);
    expect(scoped.cql).toContain(twinName);
  });
});
