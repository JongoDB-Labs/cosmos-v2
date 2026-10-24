// @vitest-environment node
//
// Workflow P3: the editor's routes. Who may read and who may change a
// project's workflows, and the problem bodies the editor builds its steps from.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole, ProjectRole, type ColumnCategory } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const calls = vi.hoisted(() => ({ ctx: null as unknown, audit: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => void calls.audit.push(e)) }));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn() }));

import { GET as listWorkflows, POST as createWorkflowRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/workflows/route";
import { GET as getWorkflowRoute, DELETE as deleteWorkflowRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/workflows/[workflowId]/route";
import { PUT as saveDraftRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/workflows/[workflowId]/draft/route";
import { GET as previewRoute, POST as publishRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/workflows/[workflowId]/publish/route";
import { PUT as assignRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/workflow/assignments/route";
import { GET as migrationRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/workflow/migration/route";
import { POST as simulateRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/workflow/simulate/route";
import { POST as createTemplateRoute } from "@/app/api/v1/orgs/[orgId]/workflow-templates/route";
import { seedBoardColumns } from "../provision.server";
import type { WorkflowDefinition } from "../definition";

let orgId = "";
let aliceId = "";
let bobId = "";
let typeId = "";
let ticket = 0;

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
  orgId = (await prisma.organization.create({ data: { name: `wfr ${stamp}`, slug: `wfr-${stamp}` } })).id;
  await prisma.orgMember.createMany({ data: [{ orgId, userId: aliceId, role: "ADMIN" }, { orgId, userId: bobId, role: "MEMBER" }] });
  typeId = (await prisma.workItemType.create({ data: { orgId, key: `bug-${stamp}`, name: "Bug" } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

beforeEach(() => {
  calls.audit.length = 0;
  actAs(aliceId, ALL);
});

const STATUSES: { key: string; name: string; category: ColumnCategory }[] = [
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "doing", name: "Doing", category: "IN_PROGRESS" },
  { key: "done", name: "Done", category: "DONE" },
];

async function project() {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const p = await prisma.project.create({ data: { orgId, name: `R ${suffix}`, key: `R${suffix}` } });
  const board = await prisma.board.create({ data: { orgId, projectId: p.id, name: "Board", type: "KANBAN" } });
  await prisma.$transaction((tx) => seedBoardColumns(tx, board, STATUSES));
  return p.id;
}

const item = (projectId: string, columnKey = "todo") =>
  prisma.workItem.create({
    data: { orgId, projectId, workItemTypeId: typeId, createdById: aliceId, title: `i ${++ticket}`, description: "", columnKey, ticketNumber: ticket },
  });

async function call<P extends Record<string, string>>(
  handler: (r: NextRequest, c: { params: Promise<P> }) => Promise<Response>,
  params: P,
  method = "GET",
  body?: unknown,
) {
  const res = await handler(
    new NextRequest("http://localhost/x", {
      method,
      ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    }),
    { params: Promise.resolve(params) },
  );
  return { status: res.status, body: await res.json() };
}

async function makeManager(projectId: string, userId: string) {
  const member = await prisma.orgMember.findFirstOrThrow({ where: { orgId, userId } });
  await prisma.projectMember.create({ data: { projectId, orgMemberId: member.id, role: ProjectRole.MANAGER } });
}

async function newWorkflow(projectId: string) {
  const r = await call(createWorkflowRoute, { orgId, projectId }, "POST", { name: `W ${Math.random()}`, from: { kind: "open" } });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe("who may read and change workflows", () => {
  it("lets a member read, and only a workflow manager or the project's manager change them", async () => {
    const p = await project();
    const id = await newWorkflow(p);
    expect(calls.audit.at(-1)).toMatchObject({ action: "workflow.created", entityId: id });

    actAs(bobId, MEMBER, { role: OrgRole.MEMBER });
    expect((await call(listWorkflows, { orgId, projectId: p })).status).toBe(200);
    expect((await call(getWorkflowRoute, { orgId, projectId: p, workflowId: id })).status).toBe(200);
    expect((await call(createWorkflowRoute, { orgId, projectId: p }, "POST", { name: "Mine", from: { kind: "open" } })).status).toBe(403);

    // As the project's manager, Bob may.
    await makeManager(p, bobId);
    expect((await call(createWorkflowRoute, { orgId, projectId: p }, "POST", { name: "Mine", from: { kind: "open" } })).status).toBe(201);
  });

  it("never lets an API key change one, whoever minted it", async () => {
    const p = await project();
    actAs(aliceId, MEMBER, { apiKey: true });
    expect((await call(listWorkflows, { orgId, projectId: p })).status).toBe(200);
    expect((await call(createWorkflowRoute, { orgId, projectId: p }, "POST", { name: "Key", from: { kind: "open" } })).status).toBe(403);
  });

  it("holds an API key to its scopes", async () => {
    const p = await project();
    actAs(aliceId, ALL, { apiKey: true, scopes: ["members:read"] });
    const r = await call(listWorkflows, { orgId, projectId: p });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("insufficient_scope");
  });

  it("answers 404 for a project of another org, under this org's id", async () => {
    const stamp = Math.random().toString(36).slice(2, 8);
    const otherOrg = await prisma.organization.create({ data: { name: `other ${stamp}`, slug: `wfr-other-${stamp}` } });
    try {
      const foreign = await prisma.project.create({ data: { orgId: otherOrg.id, name: "Foreign", key: `F${stamp.toUpperCase()}` } });
      expect((await call(listWorkflows, { orgId, projectId: foreign.id })).status).toBe(404);
      expect((await call(createWorkflowRoute, { orgId, projectId: foreign.id }, "POST", { name: "X", from: { kind: "open" } })).status).toBe(404);
      expect(await prisma.workflow.count({ where: { projectId: foreign.id } })).toBe(0);
    } finally {
      await prisma.organization.delete({ where: { id: otherOrg.id } });
    }
  });

  it("answers 404 for another project's workflow", async () => {
    const p = await project();
    const other = await project();
    const id = await newWorkflow(other);
    expect((await call(getWorkflowRoute, { orgId, projectId: p, workflowId: id })).status).toBe(404);
  });
});

describe("deleting a workflow", () => {
  it("refuses one in use, as the project default or by a type, with a 409, and deletes an unused one", async () => {
    const p = await project();
    const id = await newWorkflow(p);
    expect((await call(publishRoute, { orgId, projectId: p, workflowId: id }, "POST", {})).status).toBe(200);
    const del = () => call(deleteWorkflowRoute, { orgId, projectId: p, workflowId: id }, "DELETE");

    // The project default.
    expect((await call(assignRoute, { orgId, projectId: p }, "PUT", { workItemTypeId: null, workflowId: id })).status).toBe(200);
    expect(await del()).toMatchObject({ status: 409, body: { code: "workflow_in_use" } });

    // One type, with the default back on the open workflow.
    expect((await call(assignRoute, { orgId, projectId: p }, "PUT", { workItemTypeId: null, workflowId: null })).status).toBe(200);
    expect((await call(assignRoute, { orgId, projectId: p }, "PUT", { workItemTypeId: typeId, workflowId: id })).status).toBe(200);
    expect(await del()).toMatchObject({ status: 409, body: { code: "workflow_in_use" } });
    expect(await prisma.workflow.count({ where: { id } })).toBe(1);

    // A member without workflow-manage can't delete even an unused one.
    expect((await call(assignRoute, { orgId, projectId: p }, "PUT", { workItemTypeId: typeId, workflowId: null })).status).toBe(200);
    actAs(bobId, MEMBER, { role: OrgRole.MEMBER });
    expect((await del()).status).toBe(403);
    actAs(aliceId, ALL);

    expect((await del()).status).toBe(200);
    expect(calls.audit.at(-1)).toMatchObject({ action: "workflow.deleted", entityId: id });
    expect(await prisma.workflow.count({ where: { id } })).toBe(0);
  });
});

describe("the editor's steps", () => {
  it("draft, preview, publish with a map, assign, and the migration to watch", async () => {
    const p = await project();
    const doing = await item(p, "doing");
    const id = await newWorkflow(p);
    const def = (await call(getWorkflowRoute, { orgId, projectId: p, workflowId: id })).body.draft.definition as WorkflowDefinition;

    // A malformed draft is a 422 listing what's wrong.
    const bad = await call(saveDraftRoute, { orgId, projectId: p, workflowId: id }, "PUT", { definition: { schemaVersion: 1 } });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "workflow_invalid", issues: expect.arrayContaining([expect.objectContaining({ code: "SCHEMA" })]) });

    // First publish and assignment: nothing to map yet.
    expect((await call(publishRoute, { orgId, projectId: p, workflowId: id }, "POST", {})).status).toBe(200);
    expect(calls.audit.at(-1)).toMatchObject({ action: "workflow.published" });
    expect((await call(assignRoute, { orgId, projectId: p }, "PUT", { workItemTypeId: null, workflowId: id })).status).toBe(200);

    // Drop Doing, which holds an item.
    const next = { ...def, statuses: def.statuses.filter((s) => s.key !== "doing"), transitions: def.transitions.filter((t) => t.to !== "doing") };
    const saved = await call(saveDraftRoute, { orgId, projectId: p, workflowId: id }, "PUT", { definition: next });
    expect(saved).toMatchObject({ status: 200, body: { version: 2 } });
    const preview = await call(previewRoute, { orgId, projectId: p, workflowId: id });
    expect(preview.body.diff.removedStatuses).toEqual([{ key: "doing", items: 1 }]);

    const refused = await call(publishRoute, { orgId, projectId: p, workflowId: id }, "POST", {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "migration_map_required", statuses: [{ key: "doing", items: 1 }], options: ["todo", "done"] });

    const ok = await call(publishRoute, { orgId, projectId: p, workflowId: id }, "POST", { migrationMap: { doing: "todo" } });
    expect(ok).toMatchObject({ status: 200, body: { version: 2, migrationMap: { doing: "todo" } } });
    // Outside a request, the move waits for the job: progress says what's left.
    const pending = await call(migrationRoute, { orgId, projectId: p });
    expect(pending.body).toEqual([expect.objectContaining({ from: "doing", to: "todo", items: 1 })]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: doing.id } })).columnKey).toBe("doing");
  });

  it("simulates for another member, and refuses a non-member", async () => {
    const p = await project();
    const it0 = await item(p);
    const r = await call(simulateRoute, { orgId, projectId: p }, "POST", { itemId: it0.id, actorUserId: bobId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "todo", inWorkflow: true });
    expect(r.body.transitions.map((t: { to: string; outcome: string }) => [t.to, t.outcome])).toEqual([
      ["doing", "available"],
      ["done", "available"],
    ]);
    // Carol is a user, but not in this org.
    const stranger = (await prisma.user.findFirstOrThrow({ where: { email: "carol@test.local" } })).id;
    expect((await call(simulateRoute, { orgId, projectId: p }, "POST", { itemId: it0.id, actorUserId: stranger })).status).toBe(404);
  });

  it("saves a template only with the workflow-manage permission itself", async () => {
    const p = await project();
    const id = await newWorkflow(p);
    await call(publishRoute, { orgId, projectId: p, workflowId: id }, "POST", {});
    actAs(bobId, MEMBER, { role: OrgRole.MEMBER });
    await makeManager(p, bobId);
    expect((await call(createTemplateRoute, { orgId }, "POST", { fromWorkflowId: id, name: "T" })).status).toBe(403);
    actAs(aliceId, ALL);
    expect((await call(createTemplateRoute, { orgId }, "POST", { fromWorkflowId: id, name: `T ${Math.random()}` })).status).toBe(201);
  });

  it("won't make a template of a workflow from a project the caller can't see", async () => {
    const p = await project();
    const id = await newWorkflow(p);
    await call(publishRoute, { orgId, projectId: p, workflowId: id }, "POST", {});
    await prisma.project.update({ where: { id: p }, data: { teamScopedAccess: true } });
    // The org-wide right to manage workflows, but no place in this team-scoped project.
    actAs(bobId, MEMBER | Permission.WORKFLOW_MANAGE, { role: OrgRole.MEMBER });
    const r = await call(createTemplateRoute, { orgId }, "POST", { fromWorkflowId: id, name: `Hidden ${Math.random()}` });
    expect(r.status).toBe(403);
    expect(await prisma.workflow.count({ where: { orgId, projectId: null, name: { startsWith: "Hidden" } } })).toBe(0);
  });
});
