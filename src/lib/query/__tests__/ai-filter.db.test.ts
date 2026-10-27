// @vitest-environment node
// (e2e DB) "Ask AI to build a filter": the route and cqlFromText, with only the
// session and the model mocked. The model sees the language reference and the
// sentence, never data; a broken first answer gets one correction; the route
// returns the query and never runs it; a model failure is a 503, not a 500.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { withCqlEnabled } from "../flag";
import { seedWorld, type World } from "./cql-fixture";

const { getAuthContext, runModelTurn } = vi.hoisted(() => ({ getAuthContext: vi.fn(), runModelTurn: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/ai/egress", () => ({ runModelTurn }));
vi.mock("@/lib/rate-limit/guard", () => ({ checkRateLimit: () => null }));

import { POST as aiRoute } from "@/app/api/v1/orgs/[orgId]/cql/ai/route";
import { AiUnavailableError, cqlFromText } from "../ai-filter.server";

type Turn = { system: string; messages: { role: string; content: string }[]; ctx: { tenantClass: string; turn: number } };
const replies = (...texts: string[]) => {
  for (const text of texts) runModelTurn.mockResolvedValueOnce({ text, toolUses: [], stopReason: "end_turn" });
};
const turns = () => runModelTurn.mock.calls.map(([t]) => t as Turn);

let w: World;
beforeAll(async () => {
  w = await seedWorld();
  await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
  getAuthContext.mockImplementation(async () => w.ctx());
}, 60_000);
afterAll(async () => {
  await w?.cleanup();
});
beforeEach(() => {
  runModelTurn.mockReset();
});

const post = (body: unknown) =>
  aiRoute(
    new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/cql/ai`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    { params: Promise.resolve({ orgId: w.orgA }) },
  );

describe("cqlFromText", () => {
  it("one turn when the answer is valid; the model sees the reference and the sentence, no data, as GOV by default", async () => {
    replies("```cql\nassignee = me AND priority IN (HIGH, CRITICAL)\n```");
    const r = await cqlFromText(w.ctx(), "my urgent stuff");
    expect(r.cql).toBe("assignee = me AND priority IN (HIGH, CRITICAL)");
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const [t] = turns();
    expect(turns()).toHaveLength(1);
    expect(t.ctx.tenantClass).toBe("gov");
    expect(t.messages).toEqual([{ role: "user", content: "my urgent stuff" }]);
    expect(t.system).toContain("statusCategory");
    expect(t.system).toContain(`sev_${w.stamp}`);
    for (const leak of ["p1-login-bug", "Ada Actor", "Sprint 1", ...w.secrets]) expect(t.system).not.toContain(leak);
  });

  it("a broken answer gets its errors back once; the correction is returned", async () => {
    replies("priorty = HIGH", "priority = HIGH");
    const r = await cqlFromText(w.ctx(), "high priority");
    expect(r.cql).toBe("priority = HIGH");
    expect(turns()).toHaveLength(2);
    expect(turns()[1].ctx.turn).toBe(1);
    expect(turns()[1].messages.at(-1)!.content).toMatch(/col 1: .*priorty/);
  });

  it("still broken after the correction: returned with its diagnostics, for the user to fix", async () => {
    replies("priorty = HIGH", "priorty = HIGH");
    const r = await cqlFromText(w.ctx(), "high priority");
    expect(turns()).toHaveLength(2);
    expect(r.cql).toBe("priorty = HIGH");
    expect(r.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("a COMMERCIAL org is egressed as commercial", async () => {
    await prisma.organization.update({ where: { id: w.orgA }, data: { tenantClass: "COMMERCIAL" } });
    try {
      replies("priority = HIGH");
      await cqlFromText(w.ctx(), "high");
      expect(turns()[0].ctx.tenantClass).toBe("commercial");
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { tenantClass: "GOV" } });
    }
  });

  it("a model failure is AiUnavailableError", async () => {
    runModelTurn.mockRejectedValueOnce(new Error("no credential"));
    await expect(cqlFromText(w.ctx(), "x")).rejects.toBeInstanceOf(AiUnavailableError);
  });
});

describe("POST cql/ai", () => {
  it("returns the query and its diagnostics, and runs nothing", async () => {
    replies("priority = HIGH");
    const res = await post({ prompt: "high priority" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cql: string; diagnostics: unknown[] };
    expect(body.cql).toBe("priority = HIGH");
    expect(Object.keys(body).sort()).toEqual(["cql", "diagnostics"]);
  });

  it("a model failure is a 503 with a message; an empty or long prompt is a 400", async () => {
    runModelTurn.mockRejectedValueOnce(new Error("provider down"));
    const res = await post({ prompt: "x" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AI_UNAVAILABLE");
    expect((await post({ prompt: "  " })).status).toBe(400);
    expect((await post({ prompt: "x".repeat(501) })).status).toBe(400);
    expect(runModelTurn).toHaveBeenCalledTimes(1);
  });

  it("does not exist for an org without the query language", async () => {
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, false) as object } });
    try {
      expect((await post({ prompt: "x" })).status).toBe(404);
      expect(runModelTurn).not.toHaveBeenCalled();
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    }
  });
});
