// @vitest-environment node
//
// DOCKER ACCEPTANCE for the AgentPolicy 3-axis middle gate (design D9/§8). Runs against the
// REAL containerized Postgres (docker-compose.acceptance.yml) — the AgentPolicy loader
// (getAgentPolicy) is NOT mocked, so the policy is read from the DB exactly as in prod. Only
// the STUB MODEL (runModelTurn) and the executor (executeTool, a spy) are mocked, so we can
// drive one tool turn and assert what the agent loop actually did.
//
// Proves, end to end, against the DB:
//   1. an org WITH policy {deniedDomains:['finance'], deniedTools:['fetch_url'], maxResultLimit:10}:
//        • a FINANCE tool (query_finance) is REFUSED (domain axis) — executor NOT called.
//        • fetch_url is REFUSED (tools axis) — executor NOT called.
//        • query_work_items with limit:100 is CLAMPED to 10 AT THE EXECUTOR.
//   2. a NO-POLICY org runs ALL tools unchanged (executor receives the original args).
//   3. the agent-policy API 403s a caller without AGENT_POLICY_MANAGE.
//   4. the settings page module + panel import cleanly (renders).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

const { runModelTurn, executeTool, getAuthContext } = vi.hoisted(() => ({ runModelTurn: vi.fn(), executeTool: vi.fn(), getAuthContext: vi.fn() }));
// The route reads cookies via getAuthContext — mock it so we can drive the RBAC path against
// the REAL DB org (the org lookup + the policy upsert hit the container DB for real).
vi.mock("@/lib/auth/session", () => ({ getAuthContext, getCurrentUser: vi.fn() }));
// Mock ONLY the stub model + the executor. getAgentPolicy is REAL (hits the container DB).
vi.mock("@/lib/ai/egress", async (importOriginal) => ({ ...(await importOriginal<object>()), runModelTurn }));
vi.mock("@/lib/ai/tool-executor", () => ({ executeTool }));
// Runtime config: default (all connectors). effectiveCeiling: UNCLASSIFIED so a commercial
// org's results expose (irrelevant here — we assert the agentpolicy decision, not egress).
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: vi.fn().mockResolvedValue({ enabledConnectors: null, breadthEnabled: true, mcpEnabled: false }),
}));
vi.mock("@/lib/classification/effective", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  effectiveCeiling: vi.fn().mockResolvedValue("UNCLASSIFIED"),
}));

import { prisma } from "@/lib/db/client";
import { runAgentLoop } from "@/lib/ai/agent-loop";

const WITH_POLICY_ORG = randomUUID();
const NO_POLICY_ORG = randomUUID();
const ACCEPT_USER_ID = randomUUID();
const WITH_POLICY_SLUG = `accept-wp-${randomUUID().slice(0, 8)}`;
const NO_POLICY_SLUG = `accept-np-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  // Seed two orgs directly in the container DB.
  for (const [id, slug] of [[WITH_POLICY_ORG, WITH_POLICY_SLUG], [NO_POLICY_ORG, NO_POLICY_SLUG]] as const) {
    await prisma.organization.create({
      data: { id, name: `accept ${id}`, slug, tenantClass: "COMMERCIAL" },
    });
  }
  // The WITH_POLICY org gets a restrictive policy persisted to the DB.
  await prisma.agentPolicy.create({
    data: {
      orgId: WITH_POLICY_ORG,
      deniedDomains: ["finance"],
      deniedTools: ["fetch_url"],
      maxResultLimit: 10,
    },
  });
});

afterAll(async () => {
  await prisma.agentPolicy.deleteMany({ where: { orgId: { in: [WITH_POLICY_ORG, NO_POLICY_ORG] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [WITH_POLICY_ORG, NO_POLICY_ORG] } } });
  await prisma.$disconnect();
});

function id8() { return randomUUID().slice(0, 8); }

async function driveOneTool(orgId: string, toolUse: { id: string; name: string; input: Record<string, unknown> }) {
  runModelTurn.mockReset();
  runModelTurn
    .mockResolvedValueOnce({ text: "", toolUses: [toolUse], stopReason: "tool_use" })
    .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
  const res = await runAgentLoop({
    orgId, userId: ACCEPT_USER_ID, tenantClass: "commercial",
    systemPrompt: "sys", initialPrompt: "go", conversationId: `c-${id8()}`,
  });
  const messages = (runModelTurn.mock.calls[1]?.[0]?.messages ?? []) as Array<{ role: string; content: unknown }>;
  const secondTurnContent = JSON.stringify(messages);
  // ONLY the tool_result blocks the model receives back (the block error / clamped result) —
  // excludes the assistant's own tool_use echo (which legitimately carries the original args).
  const toolResultContent = messages
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .flatMap((m) => (m.content as Array<{ type: string; content?: string }>).filter((b) => b.type === "tool_result"))
    .map((b) => b.content ?? "")
    .join(" ");
  return { res, secondTurnContent, toolResultContent };
}

describe("ACCEPTANCE: AgentPolicy middle gate (real DB)", () => {
  it("1a. finance tool REFUSED for the with-policy org (domain axis) — executor not called", async () => {
    executeTool.mockReset().mockResolvedValue({ ok: true });
    const { toolResultContent } = await driveOneTool(WITH_POLICY_ORG, { id: "t1", name: "query_finance", input: {} });
    expect(executeTool).not.toHaveBeenCalled();
    expect(toolResultContent).toContain("blocked by agent policy");
    expect(toolResultContent).toContain("domain axis");
  });

  it("1b. fetch_url REFUSED for the with-policy org (tools axis) — executor not called", async () => {
    executeTool.mockReset().mockResolvedValue({ ok: true });
    const { toolResultContent } = await driveOneTool(WITH_POLICY_ORG, { id: "t1", name: "fetch_url", input: { url: "https://example.com" } });
    expect(executeTool).not.toHaveBeenCalled();
    expect(toolResultContent).toContain("tools axis");
    // The block error handed BACK to the model names only the axis — never the arg/URL.
    expect(toolResultContent).not.toContain("example.com");
  });

  it("1c. limit:100 CLAMPED to 10 AT THE EXECUTOR for the with-policy org", async () => {
    executeTool.mockReset().mockResolvedValue({ count: 0, items: [] });
    await driveOneTool(WITH_POLICY_ORG, { id: "t1", name: "query_work_items", input: { projectId: "p1", limit: 100 } });
    expect(executeTool).toHaveBeenCalledTimes(1);
    const [name, args] = executeTool.mock.calls[0];
    expect(name).toBe("query_work_items");
    expect(args).toMatchObject({ projectId: "p1", limit: 10 }); // clamped at the executor
  });

  it("2. the NO-POLICY org runs ALL tools UNCHANGED (permissive default)", async () => {
    executeTool.mockReset().mockResolvedValue({ ok: true });
    // finance + fetch_url + a big limit — all should EXECUTE for the no-policy org.
    await driveOneTool(NO_POLICY_ORG, { id: "t1", name: "query_finance", input: {} });
    expect(executeTool).toHaveBeenCalledTimes(1);

    executeTool.mockReset().mockResolvedValue({ ok: true });
    await driveOneTool(NO_POLICY_ORG, { id: "t1", name: "fetch_url", input: { url: "https://example.com" } });
    expect(executeTool).toHaveBeenCalledTimes(1);

    executeTool.mockReset().mockResolvedValue({ count: 0, items: [] });
    await driveOneTool(NO_POLICY_ORG, { id: "t1", name: "query_work_items", input: { projectId: "p1", limit: 100 } });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][1]).toMatchObject({ projectId: "p1", limit: 100 }); // NOT clamped
  });
});

describe("ACCEPTANCE: agent-policy API RBAC + page render (real DB)", () => {
  function authCtx(perms: bigint) {
    return { userId: ACCEPT_USER_ID, orgId: WITH_POLICY_ORG, orgRole: OrgRole.ADMIN, permissions: perms, basePermissions: perms, abacRules: [] };
  }
  function patchReq(body: unknown) {
    return new NextRequest(`http://localhost/api/v1/orgs/${WITH_POLICY_ORG}/agent-policy`, { method: "PATCH", body: JSON.stringify(body) });
  }

  it("3a. PATCH 403s a caller WITHOUT AGENT_POLICY_MANAGE", async () => {
    const { Permission } = await import("@/lib/rbac/permissions");
    const { PATCH } = await import("@/app/api/v1/orgs/[orgId]/agent-policy/route");
    getAuthContext.mockReset().mockResolvedValue(authCtx(Permission.PROJECT_READ));
    const res = await PATCH(patchReq({ deniedTools: ["fetch_url"] }), { params: Promise.resolve({ orgId: WITH_POLICY_ORG }) });
    expect(res.status).toBe(403);
  });

  it("3b. PATCH 200 + persists for an AGENT_POLICY_MANAGE caller (real DB upsert)", async () => {
    const { Permission } = await import("@/lib/rbac/permissions");
    const { PATCH } = await import("@/app/api/v1/orgs/[orgId]/agent-policy/route");
    getAuthContext.mockReset().mockResolvedValue(authCtx(Permission.AGENT_POLICY_MANAGE));
    const res = await PATCH(patchReq({ maxResultLimit: 25 }), { params: Promise.resolve({ orgId: WITH_POLICY_ORG }) });
    expect(res.status).toBe(200);
    const row = await prisma.agentPolicy.findUnique({ where: { orgId: WITH_POLICY_ORG } });
    expect(row?.maxResultLimit).toBe(25);
  });

  it("4. the settings page + panel modules import (renders)", async () => {
    const page = await import("@/app/(dashboard)/[orgSlug]/settings/agent-policy/page");
    const panel = await import("@/components/settings/agent-policy-panel");
    expect(typeof page.default).toBe("function");
    expect(typeof panel.AgentPolicyPanel).toBe("function");
  });
});
