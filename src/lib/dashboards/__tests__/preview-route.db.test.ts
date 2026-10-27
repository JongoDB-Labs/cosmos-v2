// @vitest-environment node
// (e2e DB) POST dashboards/preview-panel, with only the session mocked.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { withCqlEnabled } from "@/lib/query/flag";
import { seedWorld, type World } from "@/lib/query/__tests__/cql-fixture";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rate-limit/guard", () => ({ checkRateLimit: () => null }));

import { POST } from "@/app/api/v1/orgs/[orgId]/dashboards/preview-panel/route";

let w: World;
const post = (body: unknown) =>
  POST(new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/dashboards/preview-panel`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), {
    params: Promise.resolve({ orgId: w.orgA }),
  });

beforeAll(async () => {
  w = await seedWorld();
  await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
  getAuthContext.mockImplementation(async () => w.ctx({ denyP3: true }));
}, 60_000);
afterAll(async () => {
  await w?.cleanup();
});

describe("POST dashboards/preview-panel", () => {
  it("computes one panel as the caller, from CQL text, with the filter bar", async () => {
    const res = await post({
      type: "number",
      cql: "priority = CRITICAL",
      filters: [{ key: "person", default: null }],
      filterValues: { person: "@me" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { value: 1 }, meta: { total: 1 } });
  });

  it("a panel's own error is a 200 with { error }; bad input is a 400", async () => {
    const bad = await post({ type: "breakdown", cql: "priority = HIGH", config: { limit: 999 } });
    expect(bad.status).toBe(200);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("PANEL_INVALID_CONFIG");
    expect((await post({ type: "number", cql: "priorty = = HIGH" })).status).toBe(400);
    expect((await post({ type: "number", cql: "x = 1", query: { v: 1, where: null } })).status).toBe(400);
    expect((await post({ type: "number", cql: "priority = HIGH", tz: "Mars/Base" })).status).toBe(400);
  });

  it("does not exist with the query language off", async () => {
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, false) as object } });
    try {
      expect((await post({ type: "number", cql: "priority = HIGH" })).status).toBe(404);
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    }
  });
});
