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
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: {} } });
    try {
      expect((await queryRoute(post("work-items/query", { cql: "" }), { params: params() })).status).toBe(404);
      expect((await schemaRoute(new NextRequest("http://localhost/x"), { params: params() })).status).toBe(404);
      // ...and ?cql= on search is then just an unknown parameter.
      const s = await searchRoute(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/search?cql=x`), { params: params() });
      expect(s.status).toBe(400);
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
    const arb = fc.oneof(
      fc.string({ maxLength: 60 }),
      fc.array(fc.constantFrom(...tokens), { maxLength: 12 }).map((t) => t.join(" ")),
    );
    await fc.assert(
      fc.asyncProperty(arb, async (cql) => {
        const res = await queryRoute(post("work-items/query", { cql }), { params: params() });
        expect([200, 400, 422], cql).toContain(res.status);
        const text = await res.text();
        for (const s of w.secrets) if (!cql.includes(s)) expect(text.includes(s), cql).toBe(false);
      }),
      { numRuns: 250 },
    );
  }, 120_000);
});
