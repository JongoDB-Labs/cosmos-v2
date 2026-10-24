// @vitest-environment node
//
// Workflow P4b: the automation routes. Who may see and change rules, the 422
// a bad rule gets, the revision guard, and the scheduler's tick.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole, ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { scopeMask } from "@/lib/auth/api-key";

const calls = vi.hoisted(() => ({ ctx: null as unknown, audit: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => void calls.audit.push(e)) }));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn() }));

import { GET as listRules, POST as createRuleRoute } from "@/app/api/v1/orgs/[orgId]/automations/route";
import { GET as getRule, PATCH as patchRule, DELETE as deleteRule } from "@/app/api/v1/orgs/[orgId]/automations/[ruleId]/route";
import { GET as listRuns } from "@/app/api/v1/orgs/[orgId]/automations/[ruleId]/runs/route";
import { POST as tick } from "@/app/api/v1/orgs/[orgId]/automations/tick/route";

let orgId = "";
let aliceId = "";
let bobId = "";
const ALL = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);
const MEMBER = Permission.ITEM_READ | Permission.ITEM_UPDATE | Permission.ITEM_CREATE | Permission.PROJECT_READ;

function actAs(userId: string, permissions: bigint, opts: { role?: OrgRole; apiKey?: boolean; scopes?: string[] } = {}) {
  calls.ctx = {
    userId, orgId, orgRole: opts.role ?? OrgRole.ADMIN, permissions, basePermissions: permissions, abacRules: [],
    ...(opts.apiKey && { isApiKey: true, scopes: opts.scopes ?? ["read", "items:write"] }),
  } satisfies AuthContext;
}

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  bobId = (await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `aur ${stamp}`, slug: `aur-${stamp}` } })).id;
  await prisma.orgMember.createMany({ data: [{ orgId, userId: aliceId, role: "ADMIN" }, { orgId, userId: bobId, role: "MEMBER" }] });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

beforeEach(() => {
  calls.audit.length = 0;
  actAs(aliceId, ALL);
});

async function project() {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const p = await prisma.project.create({ data: { orgId, name: `R ${suffix}`, key: `R${suffix}` } });
  await prisma.workflowStatus.createMany({ data: [{ orgId, projectId: p.id, key: "todo", name: "To Do", category: "TODO", sortOrder: 0 }, { orgId, projectId: p.id, key: "done", name: "Done", category: "DONE", sortOrder: 1 }] });
  return p.id;
}

async function call<P extends Record<string, string>>(
  handler: (r: NextRequest, c: { params: Promise<P> }) => Promise<Response>,
  params: P,
  opts: { method?: string; body?: unknown; query?: string } = {},
) {
  const res = await handler(
    new NextRequest(`http://localhost/x${opts.query ?? ""}`, {
      method: opts.method ?? "GET",
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body), headers: { "Content-Type": "application/json" } }),
    }),
    { params: Promise.resolve(params) },
  );
  return { status: res.status, body: await res.json() };
}

const SPEC = { trigger: { on: "item.transitioned", to: ["done"] }, actions: [{ kind: "addLabels", labels: ["shipped"] }] };

describe("who may manage rules", () => {
  it("lets an automation manager create, read, edit and delete a project's rule, audited", async () => {
    const p = await project();
    const created = await call(createRuleRoute, { orgId }, { method: "POST", body: { projectId: p, name: "Ship", spec: SPEC } });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ projectId: p, ownerId: aliceId, revision: 1, enabled: true });
    expect(created.body).not.toHaveProperty("actorCap");
    expect(calls.audit.at(-1)).toMatchObject({ action: "automation.rule_created", entityId: id });

    expect((await call(listRules, { orgId }, { query: `?projectId=${p}` })).body.map((r: { id: string }) => r.id)).toEqual([id]);
    // The org-wide list doesn't include a project's rules.
    expect((await call(listRules, { orgId })).body).toEqual([]);
    expect((await call(getRule, { orgId, ruleId: id })).status).toBe(200);

    const edited = await call(patchRule, { orgId, ruleId: id }, { method: "PATCH", body: { revision: 1, enabled: false } });
    expect(edited).toMatchObject({ status: 200, body: { enabled: false, revision: 2 } });
    expect(calls.audit.at(-1)).toMatchObject({ action: "automation.rule_disabled" });
    expect((await call(patchRule, { orgId, ruleId: id }, { method: "PATCH", body: { revision: 1, name: "stale" } })).status).toBe(409);

    expect((await call(listRuns, { orgId, ruleId: id })).body).toEqual([]);
    expect((await call(deleteRule, { orgId, ruleId: id }, { method: "DELETE" })).status).toBe(200);
    expect(await prisma.automationRule.count({ where: { id } })).toBe(0);
  });

  it("lets a member manage a project's rules only as that project's manager, and never the org's", async () => {
    const p = await project();
    actAs(bobId, MEMBER, { role: OrgRole.MEMBER });
    expect((await call(createRuleRoute, { orgId }, { method: "POST", body: { projectId: p, name: "Mine", spec: SPEC } })).status).toBe(403);
    expect((await call(listRules, { orgId }, { query: `?projectId=${p}` })).status).toBe(403);

    const member = await prisma.orgMember.findFirstOrThrow({ where: { orgId, userId: bobId } });
    await prisma.projectMember.create({ data: { projectId: p, orgMemberId: member.id, role: ProjectRole.MANAGER } });
    const mine = await call(createRuleRoute, { orgId }, { method: "POST", body: { projectId: p, name: "Mine", spec: SPEC } });
    expect(mine.status).toBe(201);
    expect(mine.body.ownerId).toBe(bobId);
    expect((await call(createRuleRoute, { orgId }, { method: "POST", body: { projectId: null, name: "Org", spec: { trigger: { on: "item.created" }, actions: [{ kind: "archive" }] } } })).status).toBe(403);
    // Nor another project's.
    const other = await project();
    expect((await call(createRuleRoute, { orgId }, { method: "POST", body: { projectId: other, name: "Theirs", spec: SPEC } })).status).toBe(403);
  });

  it("never lets an API key manage rules, whoever minted it", async () => {
    const p = await project();
    // A key's permissions are its scopes' mask (no scope carries AUTOMATION_MANAGE),
    // and its owner's project role never counts (roleCountsFor).
    const scopes = ["read", "items:write", "planning:write"];
    actAs(aliceId, scopeMask(scopes), { apiKey: true, scopes });
    await prisma.projectMember.create({
      data: { projectId: p, orgMemberId: (await prisma.orgMember.findFirstOrThrow({ where: { orgId, userId: aliceId } })).id, role: ProjectRole.MANAGER },
    });
    expect((await call(createRuleRoute, { orgId }, { method: "POST", body: { projectId: p, name: "Key", spec: SPEC } })).status).toBe(403);
  });

  it("answers a project in another org, or a rule that isn't there, with a 404", async () => {
    const elsewhere = await prisma.organization.create({ data: { name: "x", slug: `x-${Date.now()}` } });
    try {
      const foreign = await prisma.project.create({ data: { orgId: elsewhere.id, name: "F", key: `F${Date.now() % 10000}` } });
      expect((await call(createRuleRoute, { orgId }, { method: "POST", body: { projectId: foreign.id, name: "F", spec: SPEC } })).status).toBe(404);
      expect((await call(getRule, { orgId, ruleId: crypto.randomUUID() })).status).toBe(404);
    } finally {
      await prisma.organization.delete({ where: { id: elsewhere.id } });
    }
  });
});

describe("a bad rule", () => {
  it("is a 400 when it isn't a rule at all, and a 422 with every issue when it names what the project lacks", async () => {
    const p = await project();
    const shape = await call(createRuleRoute, { orgId }, { method: "POST", body: { projectId: p, name: "x", spec: { trigger: { on: "whenever" }, actions: [] } } });
    expect(shape.status).toBe(400);
    const refs = await call(createRuleRoute, { orgId }, { method: "POST", body: { projectId: p, name: "x", spec: { ...SPEC, actions: [{ kind: "transition", to: "ghost" }] } } });
    expect(refs.status).toBe(422);
    expect(refs.body).toMatchObject({ code: "automation_invalid", issues: [{ path: "actions.0.to" }] });
  });
});

describe("the scheduler's tick", () => {
  it("runs with a rules:run key, and nothing else will do", async () => {
    actAs(aliceId, Permission.RULES_RUN, { apiKey: true, scopes: ["rules:run"] });
    expect(await call(tick, { orgId }, { method: "POST" })).toMatchObject({ status: 200, body: { ran: 0 } });
    actAs(aliceId, scopeMask(["read", "items:write"]), { apiKey: true, scopes: ["read", "items:write"] });
    expect((await call(tick, { orgId }, { method: "POST" })).status).toBe(403);
  });
});
