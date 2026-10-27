// @vitest-environment node
// (e2e DB) The CQL routes, with only the session mocked: real Postgres, real
// scoping, real flag. Covers the gate, the error shape, validate's modes, the
// schema's scoping, ?cql= on search, and a fuzz that may produce 200 or 400
// but never 500.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import fc from "fast-check";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { withCqlEnabled } from "../flag";
import { seedWorld, type World } from "./cql-fixture";

const { getAuthContext, limiter } = vi.hoisted(() => ({ getAuthContext: vi.fn(), limiter: { on: false } }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
// The real limiter, switchable: off so the fuzz isn't 30 requests and then 429s.
vi.mock("@/lib/rate-limit/guard", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/rate-limit/guard");
  return { ...real, checkRateLimit: (...a: Parameters<typeof real.checkRateLimit>) => (limiter.on ? real.checkRateLimit(...a) : null) };
});

import { POST as queryRoute } from "@/app/api/v1/orgs/[orgId]/work-items/query/route";
import { POST as validateRoute } from "@/app/api/v1/orgs/[orgId]/cql/validate/route";
import { GET as schemaRoute } from "@/app/api/v1/orgs/[orgId]/cql/schema/route";
import { GET as searchRoute } from "@/app/api/v1/orgs/[orgId]/work-items/search/route";
import { GET as exportRoute } from "@/app/api/v1/orgs/[orgId]/work-items/export/route";
import { GET as switchGet, PUT as switchPut } from "@/app/api/v1/orgs/[orgId]/query-language/route";
import { Permission } from "@/lib/rbac/permissions";

describe("CQL routes (e2e DB)", () => {
  let w: World;
  beforeAll(async () => {
    w = await seedWorld();
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    // A custom field on the restricted project: the schema must not list it.
    await prisma.customField.create({ data: { orgId: w.orgA, projectId: w.P2.id, key: `hidden_${w.stamp}`, name: `Hiddenfield ${w.stamp}`, fieldType: "TEXT" } });
    getAuthContext.mockImplementation(async () => w.ctx());
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const params = () => Promise.resolve({ orgId: w.orgA });
  const post = (path: string, body: unknown) =>
    new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` },
    });

  it("query: rows for valid CQL, scoped to the caller", async () => {
    const res = await queryRoute(post("work-items/query", { cql: "priority = CRITICAL ORDER BY due" }), { params: params() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string }[]; total: number; cql: string };
    // NULLS LAST for ASC: the dated item first.
    expect(body.data.map((r) => r.title)).toEqual(["p1-login-bug", `p3-denied-${w.stamp}`]);
    expect(body.cql).toBe("priority = CRITICAL ORDER BY due ASC");
  });

  it("query idsOnly: the ids search returns, no rows, scoped; past 5,000 it refuses rather than truncate", async () => {
    const full = (await (await queryRoute(post("work-items/query", { cql: "priority = CRITICAL", pageSize: 100 }), { params: params() })).json()) as { data: { id: string }[] };
    const res = await queryRoute(post("work-items/query", { cql: "priority = CRITICAL", idsOnly: true }), { params: params() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ids: string[]; data?: unknown };
    expect(body.data).toBeUndefined();
    expect(body.ids.sort()).toEqual(full.data.map((r) => r.id).sort());
    expect(body.ids).not.toContain(w.items[`p2-secret-${w.stamp}`].id);
    // Over the cap: a 422 with advice, never a silent first-5,000.
    await prisma.workItem.createMany({
      data: Array.from({ length: 5_001 }, (_, i) => ({
        orgId: w.orgA, projectId: w.P3.id, ticketNumber: 20_000 + i, title: `ids ${i}`, description: "", columnKey: "todo",
        workItemTypeId: w.typeTask, createdById: w.actor.id,
      })),
    });
    const big = await queryRoute(post("work-items/query", { cql: `project = ${w.P3.key}`, idsOnly: true }), { params: params() });
    expect(big.status).toBe(422);
    expect(await big.text()).toContain("CQL_TOO_BROAD");
    await prisma.workItem.deleteMany({ where: { projectId: w.P3.id, ticketNumber: { gte: 20_000 } } });
  }, 60_000);

  it("query: invalid CQL is a 400 with positioned diagnostics", async () => {
    const res = await queryRoute(post("work-items/query", { cql: "priorty = HIGH" }), { params: params() });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; diagnostics: { code: string; from: number; to: number }[] } };
    expect(body.error.code).toBe("CQL_INVALID");
    expect(body.error.diagnostics[0]).toMatchObject({ code: "CQL_UNKNOWN_FIELD", from: 0, to: 7 });
  });

  it("query: both or neither of cql/query is a 400; unknown body keys too", async () => {
    expect((await queryRoute(post("work-items/query", {}), { params: params() })).status).toBe(400);
    expect((await queryRoute(post("work-items/query", { cql: "", query: { v: 1, where: null } }), { params: params() })).status).toBe(400);
    expect((await queryRoute(post("work-items/query", { cql: "", filter: {} }), { params: params() })).status).toBe(400);
  });

  it("the gate: no ITEM_READ is 403; CQL switched off is 404", async () => {
    getAuthContext.mockImplementationOnce(async () => ({ ...w.ctx(), permissions: 0n, basePermissions: 0n }) as AuthContext);
    expect((await queryRoute(post("work-items/query", { cql: "" }), { params: params() })).status).toBe(403);
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, false) as object } });
    try {
      expect((await queryRoute(post("work-items/query", { cql: "" }), { params: params() })).status).toBe(404);
      expect((await schemaRoute(new NextRequest("http://localhost/x"), { params: params() })).status).toBe(404);
      expect((await validateRoute(post("cql/validate", { cql: "priority = HIGH" }), { params: params() })).status).toBe(404);
      // ...and ?cql= on search is the same 404: the parameter doesn't exist there.
      const s = await searchRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/search?cql=x`), { params: params() });
      expect(s.status).toBe(404);
      const e = await exportRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/export?cql=x`), { params: params() });
      expect(e.status).toBe(404);
      // The switch is checked first: no permissions still reads as "not here"
      // (and the session isn't even consulted).
      getAuthContext.mockImplementation(async () => ({ ...w.ctx(), permissions: 0n, basePermissions: 0n }) as AuthContext);
      expect((await queryRoute(post("work-items/query", { cql: "" }), { params: params() })).status).toBe(404);
      getAuthContext.mockImplementation(async () => w.ctx());
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    }
  });

  it("validate: warn reports unknown values as warnings, strict as errors, none skips values", async () => {
    const run = async (mode: string, cql: string) => {
      const res = await validateRoute(post("cql/validate", { cql, mode }), { params: params() });
      expect(res.status).toBe(200);
      return (await res.json()) as { valid: boolean; cql?: string; diagnostics: { code: string; severity: string }[] };
    };
    const warn = await run("warn", `sprint = "Nope" AND priority = HIGH`);
    expect(warn.diagnostics).toEqual([expect.objectContaining({ code: "CQL_UNKNOWN_VALUE", severity: "warning" })]);
    const strict = await run("strict", `sprint = "Nope"`);
    expect(strict.valid).toBe(false);
    expect(strict.diagnostics[0]).toMatchObject({ code: "CQL_UNKNOWN_VALUE", severity: "error" });
    const none = await run("none", `sprint = "Nope"`);
    expect(none.valid).toBe(true);
    const bad = await run("none", "status ~ x");
    expect(bad.valid).toBe(false);
    expect(bad.diagnostics[0].code).toBe("CQL_OPERATOR_NOT_SUPPORTED");
    const ok = await run("strict", `assignee = "Bob Builder"`);
    expect(ok).toMatchObject({ valid: true, cql: 'assignee = "Bob Builder"' });
  });

  it("schema: fields, functions, limits, and only the custom fields the caller can see", async () => {
    const res = await schemaRoute(new NextRequest("http://localhost/x"), { params: params() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fields: { id: string }[]; customFields: { key: string; name: string }[]; functions: unknown[] };
    expect(body.fields.map((f) => f.id)).toContain("assignee");
    expect(body.functions.length).toBeGreaterThan(10);
    expect(body.customFields.map((c) => c.name)).toContain("Severity");
    expect(JSON.stringify(body)).not.toContain(`Hiddenfield ${w.stamp}`);
  });

  it("search ?cql= runs CQL and refuses to mix it with legacy filters", async () => {
    const ok = await searchRoute(
      new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/search?cql=${encodeURIComponent("label = auth")}&tz=UTC`),
      { params: params() },
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: { title: string }[]; total: number };
    expect(body.total).toBe(2);
    const mixed = await searchRoute(
      new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/search?cql=x&priority=HIGH`),
      { params: params() },
    );
    expect(mixed.status).toBe(400);
  });

  it("export ?cql= writes exactly the rows search shows for the same query", async () => {
    const titlesFromCsv = (csv: string) =>
      csv
        .split("\n")
        .slice(1)
        .filter(Boolean)
        .map((line) => line.split(",")[1]);
    for (const cql of ["priority = CRITICAL ORDER BY due", "label = auth", "assignee IS EMPTY", 'text ~ "login"', "archived = true", ""]) {
      const qs = cql ? `cql=${encodeURIComponent(cql)}&tz=UTC` : "cql=";
      const s = await searchRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/search?${qs}&pageSize=100`), { params: params() });
      expect(s.status, cql).toBe(200);
      const shown = ((await s.json()) as { data: { title: string }[] }).data.map((r) => r.title);
      const e = await exportRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/export?${qs}`), { params: params() });
      expect(e.status, cql).toBe(200);
      expect(titlesFromCsv(await e.text()), cql).toEqual(shown);
    }
    // The fixture's restricted project never appears, whatever the query says.
    const all = await exportRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/export?cql=${encodeURIComponent(`project = ${w.P2.key}`)}`), { params: params() });
    expect([200, 400]).toContain(all.status);
    if (all.status === 200) expect(titlesFromCsv(await all.text())).toEqual([]);
  });

  it("export ?cql= refuses legacy filters alongside, and bad CQL is a positioned 400", async () => {
    const mixed = await exportRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/export?cql=x&priority=HIGH`), { params: params() });
    expect(mixed.status).toBe(400);
    const bad = await exportRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/export?cql=${encodeURIComponent("priorty = HIGH")}`), { params: params() });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("CQL_INVALID");
    // ...also for someone who can read nothing (no early empty CSV first).
    getAuthContext.mockImplementationOnce(async () => w.ctx({ projectScope: [] }));
    const badEmpty = await exportRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/export?cql=${encodeURIComponent("priorty = HIGH")}`), { params: params() });
    expect(badEmpty.status).toBe(400);
  });

  it("the org switch: settings admins turn CQL on and off (audited); others can't", async () => {
    const put = (enabled: boolean) =>
      new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/query-language`, { method: "PUT", body: JSON.stringify({ enabled }) });
    const schemaStatus = async () => (await schemaRoute(new NextRequest("http://localhost/x"), { params: params() })).status;
    const admin = () => ({ ...w.ctx(), permissions: w.ctx().permissions | Permission.ORG_MANAGE_SETTINGS }) as AuthContext;
    const member = () => ({ ...w.ctx(), permissions: w.ctx().permissions & ~Permission.ORG_MANAGE_SETTINGS }) as AuthContext;
    try {
      getAuthContext.mockImplementationOnce(async () => member());
      expect((await switchPut(put(false), { params: params() })).status).toBe(403);
      expect(await schemaStatus()).toBe(200);

      getAuthContext.mockImplementationOnce(async () => admin());
      expect((await switchPut(put(false), { params: params() })).status).toBe(200);
      expect(await schemaStatus()).toBe(404);
      getAuthContext.mockImplementationOnce(async () => member());
      const g = (await (await switchGet(new NextRequest("http://localhost/x"), { params: params() })).json()) as { enabled: boolean; canManage: boolean };
      expect(g).toEqual({ enabled: false, emailTitles: false, canManage: false });

      getAuthContext.mockImplementationOnce(async () => admin());
      expect((await switchPut(put(true), { params: params() })).status).toBe(200);
      expect(await schemaStatus()).toBe(200);
      const audits = await prisma.auditLog.findMany({ where: { orgId: w.orgA, action: { in: ["cql.enabled", "cql.disabled"] } }, orderBy: { createdAt: "asc" } });
      expect(audits.map((a) => a.action)).toEqual(["cql.disabled", "cql.enabled"]);
      // Other settings survive the switch.
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: w.orgA }, select: { settings: true } });
      expect(org.settings).toMatchObject({ cql: { enabled: true } });
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    }
  });

  it("the org switch never writes back settings it read before a concurrent change", async () => {
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: { ...withCqlEnabled({}, true), calendarFeeds: { enabled: true } } as object } });
    // The route's read returns settings from BEFORE someone switched calendar feeds off.
    const real = prisma.organization.findUnique.bind(prisma.organization);
    const stale = vi.spyOn(prisma.organization, "findUnique").mockImplementationOnce((async (args: never) => {
      const row = await real(args);
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: { ...withCqlEnabled({}, true), calendarFeeds: { enabled: false } } as object } });
      return row;
    }) as never);
    try {
      getAuthContext.mockImplementationOnce(async () => ({ ...w.ctx(), permissions: w.ctx().permissions | Permission.ORG_MANAGE_SETTINGS }) as AuthContext);
      const res = await switchPut(
        new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/query-language`, { method: "PUT", body: JSON.stringify({ enabled: true }) }),
        { params: params() },
      );
      expect(res.status).toBe(200);
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: w.orgA }, select: { settings: true } });
      expect(org.settings).toMatchObject({ cql: { enabled: true }, calendarFeeds: { enabled: false } });
    } finally {
      stale.mockRestore();
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    }
  });

  it("search ?cql=: bad CQL is a 400 even for someone who can read nothing; too long is a 400", async () => {
    getAuthContext.mockImplementationOnce(async () => w.ctx({ projectScope: [] }));
    const bad = await searchRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/search?cql=${encodeURIComponent("priorty = HIGH")}`), { params: params() });
    expect(bad.status).toBe(400);
    const long = await searchRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/search?cql=${"a".repeat(4001)}`), { params: params() });
    expect(long.status).toBe(400);
  });

  it("search ?cql= shares the query route's rate limit (30 per 10 s)", async () => {
    limiter.on = true;
    // The bucket refills with Date.now(); a slow run (a loaded CI box) would
    // earn tokens back mid-test. Frozen, 32 requests are 32 requests.
    vi.useFakeTimers({ toFake: ["Date"] });
    // Its own user, so this bucket isn't the one the query-route test uses.
    getAuthContext.mockImplementation(async () => ({ ...w.ctx(), userId: w.bob.id }) as AuthContext);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) {
        const r = await searchRoute(
          new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/search?cql=${encodeURIComponent("priority = HIGH")}`, { headers: { "x-forwarded-for": "10.9.9.9" } }),
          { params: params() },
        );
        statuses.push(r.status);
      }
      expect(statuses).toContain(429);
      expect(statuses.slice(0, 20).every((x) => x === 200)).toBe(true);
    } finally {
      vi.useRealTimers();
      limiter.on = false;
      getAuthContext.mockImplementation(async () => w.ctx());
    }
  });

  it("nesting that would overflow the stack is a 400, by text or JSON — never a 500", async () => {
    const leaf = { op: "cmp", field: { kind: "sys", id: "priority" }, cmp: "eq", value: { t: "str", v: "HIGH" } };
    let deep: unknown = leaf;
    for (let i = 0; i < 1300; i++) deep = { op: "not", arg: deep };
    const cases = [
      { cql: `${"(".repeat(316)}priority = HIGH${")".repeat(316)}` },
      { cql: `${"(".repeat(471)}priority = HIGH` },
      { cql: `${"NOT ".repeat(900)}priority = HIGH` },
      { query: { v: 1, where: deep } },
      { query: { v: 1, where: { op: "and", args: Array.from({ length: 123_000 }, () => leaf) } } },
    ];
    for (const body of cases) {
      const res = await queryRoute(post("work-items/query", body), { params: params() });
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CQL_INVALID");
    }
  });

  it("JSON refs to people, labels or types from elsewhere match nothing and never print their forged label", async () => {
    const other = await prisma.user.create({ data: { email: `other-${w.stamp}@x.test`, displayName: `Otherorg ${w.stamp}` } });
    const foreignLabel = await prisma.label.create({ data: { orgId: w.orgB, name: `Foreignlabel ${w.stamp}` } });
    try {
      for (const value of [
        { t: "ref", entity: "user", id: other.id, label: "Forged Name" },
        { t: "ref", entity: "label", id: foreignLabel.id, label: "Forged Name" },
        { t: "ref", entity: "type", id: "00000000-0000-4000-8000-000000000000", label: "Forged Name" },
      ]) {
        const field = { user: "assignee", label: "label", type: "type" }[value.entity as "user"];
        const res = await queryRoute(post("work-items/query", { query: { v: 1, where: { op: "cmp", field: { kind: "sys", id: field }, cmp: "eq", value } } }), { params: params() });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: unknown[]; cql: string };
        expect(body.data).toEqual([]);
        expect(JSON.stringify(body)).not.toContain("Forged Name");
      }
      // A real member, by id, still works (the check is "is this ours", not "is this a name").
      const mine = await queryRoute(post("work-items/query", { query: { v: 1, where: { op: "cmp", field: { kind: "sys", id: "assignee" }, cmp: "eq", value: { t: "ref", entity: "user", id: w.actor.id } } } }), { params: params() });
      expect(((await mine.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0);
    } finally {
      await prisma.label.delete({ where: { id: foreignLabel.id } }).catch(() => undefined);
      await prisma.user.delete({ where: { id: other.id } }).catch(() => undefined);
    }
  });

  it("query is rate-limited per user (30 per 10 s)", async () => {
    limiter.on = true;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 40; i++) {
        statuses.push((await queryRoute(post("work-items/query", { cql: "priority = HIGH" }), { params: params() })).status);
      }
      // A burst of 30 passes; the bucket refills at 3/s, so what follows is
      // mostly, not only, 429.
      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(30).filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
    } finally {
      limiter.on = false;
    }
  });

  it("fuzz: any string is a 200 or a 400, never a 500, and never names a restricted thing", async () => {
    const tokens = ["(", ")", "=", "!=", "~", "AND", "OR", "NOT", "IN", "IS", "EMPTY", "ORDER BY", ",", '"', "'", "me", "$x", "-7d", "priority", "assignee", "cf[", "]", "openSprints()", "\\", "%", "\u0000", "'; DROP TABLE work_items; --", "$1"];
    // Deep nesting, the stack-overflow class: runs of "(" (closed or not),
    // NOT / ! and nested calls, at any depth up to the text limit.
    const deep = fc
      .tuple(fc.constantFrom("(", "NOT ", "! ", "childrenOf("), fc.integer({ min: 1, max: 900 }), fc.boolean())
      .map(([open, n, close]) => `${open.repeat(n)}priority = HIGH${close && open.endsWith("(") ? ")".repeat(n) : ""}`);
    const arb = fc.oneof(
      fc.string({ maxLength: 60 }),
      fc.array(fc.constantFrom(...tokens), { maxLength: 12 }).map((t) => t.join(" ")),
      deep,
    );
    await fc.assert(
      fc.asyncProperty(arb, async (cql) => {
        const res = await queryRoute(post("work-items/query", { cql }), { params: params() });
        expect([200, 400, 422], cql).toContain(res.status);
        const text = await res.text();
        for (const s of w.secrets) if (!cql.includes(s)) expect(text.includes(s), cql).toBe(false);
      }),
      { numRuns: 300 },
    );
  }, 120_000);

  it("a NUL character is a 400, as text or inside a JSON string (Postgres text can't hold one)", async () => {
    // Found by the fuzz above: `" \u0000 "` reached the database as a text search.
    for (const cql of ['" \u0000 "', 'summary ~ "a\u0000b"', "\u0000"]) {
      expect((await queryRoute(post("work-items/query", { cql }), { params: params() })).status, JSON.stringify(cql)).toBe(400);
    }
    const query = { v: 1, where: { op: "text", field: { kind: "sys", id: "text" }, query: "a\u0000b" } };
    expect((await queryRoute(post("work-items/query", { query }), { params: params() })).status).toBe(400);
    const str = { v: 1, where: { op: "cmp", field: { kind: "sys", id: "status" }, cmp: "eq", value: { t: "str", v: "\u0000" } } };
    expect((await queryRoute(post("work-items/query", { query: str }), { params: params() })).status).toBe(400);
  });

  it("fuzz: any JSON nesting is a 200 or a 400, never a 500", async () => {
    const leaf = { op: "cmp", field: { kind: "sys", id: "priority" }, cmp: "eq", value: { t: "str", v: "HIGH" } };
    // The body is built as TEXT, the way an attacker would send it:
    // JSON.stringify itself overflows on these, the server's JSON.parse
    // doesn't. Built inside the property, so a failure prints as (kind, n).
    const LEAF = JSON.stringify(leaf);
    const body = (kind: string, n: number) => {
      const [open, close] =
        kind === "not"
          ? ['{"op":"not","arg":', "}"]
          : kind === "fn"
            ? ['{"t":"fn","name":"childrenOf","args":[', "]}"]
            : [`{"op":"${kind}","args":[`, `,${LEAF}]}`];
      const inner = kind === "fn" ? '{"t":"str","v":"X-1"}' : LEAF;
      const tree = open.repeat(n) + inner + close.repeat(n);
      const where = kind === "fn" ? `{"op":"in","field":{"kind":"sys","id":"key"},"values":[${tree}]}` : tree;
      return `{"query":{"v":1,"where":${where}}}`;
    };
    const raw = (text: string) =>
      new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/query`, { method: "POST", body: text, headers: { "content-type": "application/json" } });
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("not", "and", "or", "fn"), fc.integer({ min: 1, max: 20_000 }), async (kind, n) => {
        const res = await queryRoute(raw(body(kind, n)), { params: params() });
        expect([200, 400], `${kind} × ${n}: ${res.status}`).toContain(res.status);
      }),
      { numRuns: 60 },
    );
  }, 120_000);
});
