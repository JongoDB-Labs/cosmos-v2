// @vitest-environment node
//
// The workflow engine through the routes people and the assistant use, against
// a real database: the open workflow's checks, a custom workflow's four verbs,
// shadow mode, the override, bulk denials, and the transitions list.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { OrgRole, type ColumnCategory } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { WorkflowDefinition } from "../definition";

const calls = vi.hoisted(() => ({ ctx: null as unknown, audit: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => void calls.audit.push(e)) }));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock("@/lib/integrations/teams-notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/teams-notify")>()),
  teamsNotify: vi.fn(),
}));
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn(async () => undefined) }));

import { PUT as putItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";
import { PUT as bulkPut } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/bulk/route";
import { GET as getTransitions } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/transitions/route";
import { PUT as putSettings } from "@/app/api/v1/orgs/[orgId]/workflow-settings/route";
import { GET as getMoves } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/workflow/moves/route";
import { seedBoardColumns } from "../provision.server";
import { listTransitionsForItem, transitionItem } from "@/lib/ai/executors/work-items";
import { stubToolCtx } from "@/lib/testing/tool-auth";
import { applyWorkItemChange } from "@/lib/work-items/apply-change.server";
import { mergeWorkItems } from "@/lib/work-items/merge.server";

let orgId = "";
let aliceId = "";
let bobId = "";
let typeId = "";
let otherTypeId = "";
let ticket = 0;

const ALL = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);
/** An admin: every bit but the override, which is OWNER-only. */
const ADMIN = ALL & ~Permission.WORKFLOW_OVERRIDE;

function actAs(userId: string, opts: { owner?: boolean } = {}) {
  const permissions = opts.owner ? ALL : ADMIN;
  calls.ctx = {
    userId, orgId, orgRole: opts.owner ? OrgRole.OWNER : OrgRole.ADMIN, permissions, basePermissions: permissions, abacRules: [],
  } satisfies AuthContext;
}

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  bobId = (await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `wfe ${stamp}`, slug: `wfe-${stamp}` } })).id;
  await prisma.orgMember.createMany({ data: [{ orgId, userId: aliceId, role: "ADMIN" }, { orgId, userId: bobId, role: "MEMBER" }] });
  typeId = (await prisma.workItemType.create({ data: { orgId, key: `bug-${stamp}`, name: "Bug" } })).id;
  otherTypeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

beforeEach(() => {
  calls.audit.length = 0;
  actAs(aliceId);
});

const STATUSES: { key: string; name: string; category: ColumnCategory }[] = [
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "doing", name: "Doing", category: "IN_PROGRESS" },
  { key: "done", name: "Done", category: "DONE" },
  { key: "cancelled", name: "Cancelled", category: "CANCELLED" },
];

async function world(opts: { boardConfig?: object; wipLimit?: number } = {}) {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const project = await prisma.project.create({ data: { orgId, name: `E ${suffix}`, key: `E${suffix}` } });
  const board = await prisma.board.create({
    data: { orgId, projectId: project.id, name: "Board", type: "KANBAN", config: opts.boardConfig ?? {} },
  });
  await seedBoardColumns(prisma, board, STATUSES);
  if (opts.wipLimit !== undefined) {
    await prisma.boardColumn.updateMany({ where: { boardId: board.id, key: "doing" }, data: { wipLimit: opts.wipLimit } });
  }
  return { projectId: project.id, boardId: board.id };
}

async function item(projectId: string, data: Record<string, unknown> = {}) {
  const row = await prisma.workItem.create({
    data: {
      orgId, projectId, workItemTypeId: typeId, createdById: aliceId, title: `item ${++ticket}`,
      description: "", columnKey: "todo", ticketNumber: ticket, ...data,
    },
  });
  return row.id;
}

async function put(projectId: string, itemId: string, body: Record<string, unknown>) {
  const res = await putItem(
    new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ orgId, projectId, itemId }) },
  );
  return { status: res.status, body: await res.json() };
}

const columnOf = async (id: string) => (await prisma.workItem.findUniqueOrThrow({ where: { id } })).columnKey;

/** Publish a custom workflow and assign it, as the editor will. */
async function customWorkflow(
  projectId: string,
  def: WorkflowDefinition,
  opts: { workItemTypeId?: string | null; enforcement?: "SHADOW" | "ENFORCE" } = {},
) {
  const wf = await prisma.workflow.create({
    data: { orgId, projectId, name: `wf ${Math.random()}`, createdById: aliceId, enforcement: opts.enforcement ?? "ENFORCE" },
  });
  const version = await prisma.workflowVersion.create({
    data: {
      orgId, workflowId: wf.id, version: 1, state: "PUBLISHED", definition: def,
      checksum: createHash("sha256").update(JSON.stringify(def)).digest("hex"), publishedAt: new Date(),
    },
  });
  await prisma.workflow.update({ where: { id: wf.id }, data: { publishedVersionId: version.id } });
  await prisma.workflowAssignment.create({
    data: { orgId, projectId, workItemTypeId: opts.workItemTypeId ?? null, workflowId: wf.id },
  });
  return wf.id;
}

/** todo -> doing (assignee only) -> done (asks for a resolution, labels the item). */
const GOVERNED: WorkflowDefinition = {
  schemaVersion: 1,
  statuses: [{ key: "todo", isInitial: true }, { key: "doing" }, { key: "done" }, { key: "cancelled" }],
  transitions: [
    { id: "start", name: "Start work", from: ["todo"], to: "doing", restrict: { kind: "actorIsAssignee" } },
    {
      id: "resolve", name: "Resolve", from: ["doing"], to: "done",
      input: [{ field: { system: "resolution" }, required: true }],
      actions: [{ kind: "addLabels", labels: ["resolved"] }],
    },
    { id: "reopen", name: "Reopen", from: ["done"], to: "todo" },
    { id: "abandon", name: "Abandon", from: "*", to: "cancelled", hidden: true },
  ],
};

describe("the open workflow", () => {
  it("moves anything anywhere, as the board always did", async () => {
    const w = await world();
    const a = await item(w.projectId);
    expect((await put(w.projectId, a, { columnKey: "done" })).status).toBe(200);
    expect((await put(w.projectId, a, { columnKey: "todo" })).status).toBe(200);
    expect(await columnOf(a)).toBe("todo");
  });

  it("refuses to finish a parent over an open child, on every path, unless the org turned it off", async () => {
    const w = await world();
    const parent = await item(w.projectId);
    await item(w.projectId, { parentId: parent, title: "the open child" });
    await item(w.projectId, { parentId: parent, columnKey: "cancelled" });

    const refused = await put(w.projectId, parent, { columnKey: "done" });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "transition_invalid", reasons: [{ validator: "childrenSettled" }] });
    expect(refused.body.error).toContain("the open child");
    expect(await columnOf(parent)).toBe("todo");

    // Moving it anywhere but Done is fine.
    expect((await put(w.projectId, parent, { columnKey: "doing" })).status).toBe(200);

    const off = await putSettings(
      new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ blockParentWithOpenChildren: false }) }),
      { params: Promise.resolve({ orgId }) },
    );
    expect(off.status).toBe(200);
    try {
      expect((await put(w.projectId, parent, { columnKey: "done" })).status).toBe(200);
    } finally {
      await prisma.organization.update({ where: { id: orgId }, data: { settings: {} } });
    }
  });

  it("holds a board's hard WIP limit from every surface, not only that board", async () => {
    const w = await world({ boardConfig: { wipHardEnforce: true }, wipLimit: 1 });
    await item(w.projectId, { columnKey: "doing" });
    const b = await item(w.projectId);
    for (const body of [{ columnKey: "doing", boardId: w.boardId }, { columnKey: "doing" }]) {
      const refused = await put(w.projectId, b, body);
      expect(refused.status).toBe(422);
      // Named as the board names it, with the board: the move may not have come from it.
      expect(refused.body).toMatchObject({
        code: "transition_invalid",
        reasons: [{ validator: "wipLimit", message: '"Doing" on Board is at its WIP limit (1) — move blocked.' }],
      });
    }
    expect(await columnOf(b)).toBe("todo");
  });

  it("holds a team board's limit only for that team's items", async () => {
    const w = await world();
    const team = await prisma.team.create({ data: { orgId, projectId: w.projectId, name: "Platform" } });
    await prisma.board.update({ where: { id: w.boardId }, data: { teamId: team.id, config: { wipHardEnforce: true } } });
    await prisma.boardColumn.updateMany({ where: { boardId: w.boardId, key: "doing" }, data: { wipLimit: 1 } });
    await item(w.projectId, { columnKey: "doing", teamId: team.id });
    const theirs = await item(w.projectId, { teamId: team.id });
    const nobodys = await item(w.projectId);
    expect((await put(w.projectId, theirs, { columnKey: "doing" })).status).toBe(422);
    expect((await put(w.projectId, nobodys, { columnKey: "doing" })).status).toBe(200);
  });

  it("admits a bulk move only up to the places left, and refuses the rest", async () => {
    const w = await world({ boardConfig: { wipHardEnforce: true }, wipLimit: 3 });
    await item(w.projectId, { columnKey: "doing" });
    await item(w.projectId, { columnKey: "doing" });
    const ids = await Promise.all(Array.from({ length: 10 }, () => item(w.projectId)));
    const res = await bulkPut(
      new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ ids, update: { columnKey: "doing" } }) }),
      { params: Promise.resolve({ orgId, projectId: w.projectId }) },
    );
    const body = await res.json();
    // In the order given: the first takes the one place left, each of the rest is refused for the limit.
    expect(body.updated).toBe(1);
    expect(body.denied).toHaveLength(9);
    expect(new Set(body.denied.map((d: { code: string }) => d.code))).toEqual(new Set(["transition_invalid"]));
    expect(await prisma.workItem.count({ where: { projectId: w.projectId, columnKey: "doing" } })).toBe(3);
    expect(await columnOf(ids[0])).toBe("doing");
  });

  it("holds a team board's limit when only the team changes, or an action sets it", async () => {
    const w = await world();
    const team = await prisma.team.create({ data: { orgId, projectId: w.projectId, name: "Platform" } });
    await prisma.board.update({ where: { id: w.boardId }, data: { teamId: team.id, config: { wipHardEnforce: true } } });
    await prisma.boardColumn.updateMany({ where: { boardId: w.boardId, key: "doing" }, data: { wipLimit: 1 } });
    await item(w.projectId, { columnKey: "doing", teamId: team.id });

    // Already in Doing, off the team: joining the team would put it on that full board.
    const joining = await item(w.projectId, { columnKey: "doing" });
    const r = await put(w.projectId, joining, { teamId: team.id });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: "transition_invalid", reasons: [{ validator: "wipLimit" }] });
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: joining } })).teamId).toBeNull();

    // A transition whose action sets the team: the team it ends up in is the one counted.
    await customWorkflow(w.projectId, {
      ...GOVERNED,
      transitions: [{
        id: "pick-up", name: "Pick up", from: ["todo"], to: "doing",
        validate: [{ kind: "wipLimit", scope: "board", hard: true }],
        actions: [{ kind: "setField", field: { system: "teamId" }, value: { literal: team.id } }],
      }],
    });
    const picked = await item(w.projectId);
    const moved = await put(w.projectId, picked, { columnKey: "doing" });
    expect(moved.status).toBe(422);
    expect(moved.body).toMatchObject({ code: "transition_invalid", reasons: [{ validator: "wipLimit" }] });
    expect(await columnOf(picked)).toBe("todo");
  });

  it("does not hold a soft WIP limit", async () => {
    const w = await world({ wipLimit: 1 });
    await item(w.projectId, { columnKey: "doing" });
    const b = await item(w.projectId);
    expect((await put(w.projectId, b, { columnKey: "doing", boardId: w.boardId })).status).toBe(200);
  });
});

describe("a change with no person behind it", () => {
  // The system's own steps (source SYSTEM, actor null) and a composed plugin's
  // call, which passes no actor at all.
  const systemMove = (projectId: string, itemId: string, patch: Record<string, unknown>, plugin = false) =>
    prisma.$transaction((tx) =>
      applyWorkItemChange(tx, {
        actorId: aliceId, orgId, projectId, itemIds: [itemId], patch,
        ...(plugin ? { source: "API" as const } : { source: "SYSTEM" as const, actor: null }),
      }),
    );

  it("is still held to the parent guard", async () => {
    const w = await world();
    const parent = await item(w.projectId);
    await item(w.projectId, { parentId: parent });
    await expect(systemMove(w.projectId, parent, { columnKey: "done" })).rejects.toMatchObject({ body: { code: "transition_invalid" } });
    await expect(systemMove(w.projectId, parent, { columnKey: "done" }, true)).rejects.toMatchObject({ body: { code: "transition_invalid" } });
    expect(await columnOf(parent)).toBe("todo");
  });

  it("is not restricted or asked for input, and may take a hidden transition", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId);
    await systemMove(w.projectId, a, { columnKey: "doing" });
    expect(await columnOf(a)).toBe("doing");
    await systemMove(w.projectId, a, { columnKey: "done" });
    expect(await columnOf(a)).toBe("done");
    await systemMove(w.projectId, a, { columnKey: "cancelled", cancelReason: "OTHER" }, true);
    expect(await columnOf(a)).toBe("cancelled");
  });

  it("still needs a transition to exist", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId);
    await expect(systemMove(w.projectId, a, { columnKey: "done" })).rejects.toMatchObject({ body: { code: "transition_not_allowed" } });
  });
});

describe("a custom workflow", () => {
  it("refuses a move it has no transition for", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId);
    const r = await put(w.projectId, a, { columnKey: "done" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("transition_not_allowed");
    expect(await columnOf(a)).toBe("todo");
  });

  it("restricts who may take a transition", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId, { assigneeId: bobId });
    await prisma.workItemAssignee.create({ data: { workItemId: a, userId: bobId, sortOrder: 0 } });
    const r = await put(w.projectId, a, { columnKey: "doing" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "transition_forbidden", transition: { id: "start" } });

    actAs(bobId);
    expect((await put(w.projectId, a, { columnKey: "doing" })).status).toBe(200);
  });

  it("asks for input, then takes it, runs the actions and records the transition", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId, { columnKey: "doing" });

    const asked = await put(w.projectId, a, { columnKey: "done" });
    expect(asked.status).toBe(422);
    expect(asked.body).toMatchObject({
      code: "transition_input_required",
      transition: { id: "resolve", name: "Resolve", to: "done" },
      fields: [{ field: { system: "resolution" }, required: true, options: expect.arrayContaining([{ value: "Fixed", label: "Fixed" }]) }],
    });

    const done = await put(w.projectId, a, { columnKey: "done", transition: { input: { "system:resolution": "Fixed" } } });
    expect(done.status).toBe(200);
    const row = await prisma.workItem.findUniqueOrThrow({ where: { id: a } });
    expect(row).toMatchObject({ columnKey: "done", resolution: "Fixed", tags: ["resolved"] });
    expect(row.completedAt).not.toBeNull();
    expect(await prisma.activity.findFirst({ where: { workItemId: a, action: "transitioned" } })).toMatchObject({
      field: "transition", newValue: "resolve", userId: aliceId,
    });

    // Reopening clears the outcome.
    expect((await put(w.projectId, a, { columnKey: "todo" })).status).toBe(200);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: a } })).resolution).toBeNull();
  });

  it("only takes input the transition asked for", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId, { columnKey: "doing" });
    await put(w.projectId, a, {
      columnKey: "done",
      transition: { input: { "system:resolution": "Fixed", "system:priority": "CRITICAL" } },
    });
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: a } })).priority).not.toBe("CRITICAL");
  });

  it("asks for a type's required fields on a move into In progress", async () => {
    const w = await world();
    const field = await prisma.customField.create({
      data: { orgId, name: "Root cause", key: `root_${Math.random().toString(36).slice(2, 7)}`, fieldType: "SELECT", options: ["Code", "Config"] },
    });
    await prisma.workItemTypeField.create({ data: { workItemTypeId: typeId, customFieldId: field.id, required: true } });
    try {
      const a = await item(w.projectId);
      const asked = await put(w.projectId, a, { columnKey: "doing" });
      expect(asked.status).toBe(422);
      expect(asked.body.fields).toEqual([
        { field: { custom: field.key }, required: true, label: "Root cause", options: [{ value: "Code", label: "Code" }, { value: "Config", label: "Config" }] },
      ]);
      // A move into To Do or Cancelled does not ask.
      expect((await put(w.projectId, a, { columnKey: "cancelled" })).status).toBe(200);
      const b = await item(w.projectId);
      expect((await put(w.projectId, b, { columnKey: "doing", transition: { input: { [`custom:${field.key}`]: "Code" } } })).status).toBe(200);
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id: b } })).customFields).toMatchObject({ [field.key]: "Code" });
    } finally {
      await prisma.workItemTypeField.deleteMany({ where: { customFieldId: field.id } });
    }
  });

  it("never offers or takes a hidden transition", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId);
    const r = await put(w.projectId, a, { columnKey: "cancelled" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("transition_not_allowed");
  });

  it("governs per type, with the project default for the rest", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED, { workItemTypeId: otherTypeId });
    const bug = await item(w.projectId);
    const task = await item(w.projectId, { workItemTypeId: otherTypeId });
    expect((await put(w.projectId, bug, { columnKey: "done" })).status).toBe(200);
    expect((await put(w.projectId, task, { columnKey: "done" })).status).toBe(409);
  });

  it("lets a type's own workflow win over the project default", async () => {
    const w = await world();
    // A permissive default: any status to any status, as a custom workflow.
    await customWorkflow(w.projectId, {
      schemaVersion: 1,
      statuses: GOVERNED.statuses,
      transitions: GOVERNED.statuses.map((st) => ({ id: `any-${st.key}`, name: st.key, from: "*" as const, to: st.key })),
    });
    await customWorkflow(w.projectId, GOVERNED, { workItemTypeId: otherTypeId });
    const bug = await item(w.projectId);
    const task = await item(w.projectId, { workItemTypeId: otherTypeId });
    expect((await put(w.projectId, bug, { columnKey: "done" })).status).toBe(200);
    expect((await put(w.projectId, task, { columnKey: "done" })).status).toBe(409);
  });

  it("refuses a type change into a workflow without the item's status", async () => {
    const w = await world();
    await customWorkflow(w.projectId, { ...GOVERNED, statuses: GOVERNED.statuses.filter((s) => s.key !== "doing") }, { workItemTypeId: otherTypeId });
    const a = await item(w.projectId, { columnKey: "doing" });
    const r = await put(w.projectId, a, { workItemTypeId: otherTypeId });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "type_change_needs_status", statuses: ["todo", "done", "cancelled"] });
  });

  it("holds a status's read-only fields on any edit", async () => {
    const w = await world();
    await customWorkflow(w.projectId, {
      ...GOVERNED,
      statuses: GOVERNED.statuses.map((s) => (s.key === "done" ? { ...s, fieldRules: [{ field: { system: "priority" }, rule: "readOnly" }] } : s)),
    });
    const a = await item(w.projectId, { columnKey: "done" });
    const r = await put(w.projectId, a, { priority: "HIGH" });
    expect(r.status).toBe(422);
    expect(r.body.reasons[0]).toMatchObject({ validator: "field", fields: [{ system: "priority" }] });
    expect((await put(w.projectId, a, { title: "renamed" })).status).toBe(200);
  });

  it("in shadow mode records what it would have blocked and blocks nothing", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED, { enforcement: "SHADOW" });
    const a = await item(w.projectId);
    expect((await put(w.projectId, a, { columnKey: "done" })).status).toBe(200);
    expect(await columnOf(a)).toBe("done");
    expect(calls.audit.find((e) => e.action === "workflow.shadow_denied")).toMatchObject({
      entityId: a, metadata: expect.objectContaining({ code: "transition_not_allowed" }),
    });
  });
});

describe("shadow mode", () => {
  it("lets a restricted transition through and records the refusal", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED, { enforcement: "SHADOW" });
    const a = await item(w.projectId);
    // Not the assignee: an enforced workflow would answer 403.
    expect((await put(w.projectId, a, { columnKey: "doing" })).status).toBe(200);
    expect(await columnOf(a)).toBe("doing");
    expect(calls.audit.find((e) => e.action === "workflow.shadow_denied")).toMatchObject({
      entityId: a, metadata: expect.objectContaining({ code: "transition_forbidden", transition: "start" }),
    });
  });
});

describe("the override", () => {
  it("is refused without WORKFLOW_OVERRIDE, and taken and audited with it", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId, { columnKey: "doing" });

    const refused = await put(w.projectId, a, { columnKey: "done", transition: { force: true } });
    expect(refused.status).toBe(403);
    expect(await columnOf(a)).toBe("doing");

    actAs(aliceId, { owner: true });
    expect((await put(w.projectId, a, { columnKey: "done", transition: { force: true } })).status).toBe(200);
    expect(await columnOf(a)).toBe("done");
    expect(calls.audit.find((e) => e.action === "work_item.transition_forced")).toMatchObject({
      entityId: a, metadata: expect.objectContaining({ code: "transition_input_required", transition: "resolve" }),
    });
  });
});

describe("bulk", () => {
  it("refuses every item it has no transition for, and writes none of them", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId);
    const b = await item(w.projectId);
    const res = await bulkPut(
      new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ ids: [a, b], update: { columnKey: "done" } }) }),
      { params: Promise.resolve({ orgId, projectId: w.projectId }) },
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.updated).toBe(0);
    expect(body.denied.map((d: { id: string; code: string }) => [d.id, d.code])).toEqual([
      [a, "transition_not_allowed"],
      [b, "transition_not_allowed"],
    ]);
    expect([await columnOf(a), await columnOf(b)]).toEqual(["todo", "todo"]);
  });

  it("applies collected input to every item, and moves the rest when one is refused", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId, { columnKey: "doing" });
    const b = await item(w.projectId, { columnKey: "doing" });
    const c = await item(w.projectId);
    const res = await bulkPut(
      new NextRequest("http://localhost/x", {
        method: "PUT",
        body: JSON.stringify({ ids: [a, b, c], update: { columnKey: "done" }, transition: { input: { "system:resolution": "Duplicate" } } }),
      }),
      { params: Promise.resolve({ orgId, projectId: w.projectId }) },
    );
    const body = await res.json();
    expect(body.updated).toBe(2);
    expect(body.denied).toEqual([{ id: c, code: "transition_not_allowed", message: expect.any(String) }]);
    for (const id of [a, b]) {
      expect(await prisma.workItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ columnKey: "done", resolution: "Duplicate" });
    }
    expect(await columnOf(c)).toBe("todo");
  });
});

describe("the transitions list", () => {
  const list = async (projectId: string, itemId: string) => {
    const res = await getTransitions(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId, projectId, itemId }) });
    return { status: res.status, body: await res.json() };
  };

  it("offers the open workflow's moves out of the current status", async () => {
    const w = await world();
    const a = await item(w.projectId);
    const r = await list(w.projectId, a);
    expect(r.status).toBe(200);
    expect(r.body.map((t: { to: string }) => t.to)).toEqual(["doing", "done", "cancelled"]);
    expect(r.body[0]).toEqual({ id: "open:doing", name: "Doing", to: "doing", toCategory: "IN_PROGRESS", input: [] });
  });

  it("leaves out hidden and restricted transitions, and lists what each asks for", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId);
    expect((await list(w.projectId, a)).body).toEqual([]);
    await prisma.workItemAssignee.create({ data: { workItemId: a, userId: aliceId, sortOrder: 0 } });
    expect((await list(w.projectId, a)).body.map((t: { id: string }) => t.id)).toEqual(["start"]);

    const d = await item(w.projectId, { columnKey: "doing" });
    const [resolve] = (await list(w.projectId, d)).body;
    expect(resolve).toMatchObject({ id: "resolve", toCategory: "DONE", input: [{ field: { system: "resolution" }, required: true }] });
  });
});

describe("the assistant", () => {
  it("lists transitions and takes one with input, and is told what to ask for when it has none", async () => {
    const w = await world();
    await customWorkflow(w.projectId, GOVERNED);
    const a = await item(w.projectId, { columnKey: "doing" });
    const ctx = stubToolCtx(orgId, aliceId, { orgRole: OrgRole.ADMIN, permissions: ADMIN });

    const listed = (await listTransitionsForItem({ itemId: a }, ctx)) as { transitions: { id: string; requiresInput: boolean }[] };
    expect(listed.transitions).toEqual([expect.objectContaining({ id: "resolve", requiresInput: true })]);

    const asked = (await transitionItem({ itemId: a, transitionId: "resolve" }, ctx)) as Record<string, unknown>;
    expect(asked).toMatchObject({ code: "transition_input_required", transitionId: "resolve", fields: [{ field: { system: "resolution" }, required: true }] });

    const done = (await transitionItem({ itemId: a, transitionId: "resolve", input: { "system:resolution": "Fixed" } }, ctx)) as Record<string, unknown>;
    expect(done).toMatchObject({ updated: true, columnKey: "done" });
  });

  it("is never told a check's message, which can quote item content", async () => {
    const w = await world();
    const parent = await item(w.projectId);
    await item(w.projectId, { parentId: parent, title: "SECRET child title" });
    const ctx = stubToolCtx(orgId, aliceId, { orgRole: OrgRole.ADMIN, permissions: ADMIN });
    const r = (await transitionItem({ itemId: parent, transitionId: "open:done" }, ctx)) as Record<string, unknown>;
    expect(r).toMatchObject({ code: "transition_invalid", failedChecks: ["childrenSettled"] });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});

describe("the moves map a board dims columns with", () => {
  const moves = async (projectId: string) =>
    (await getMoves(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId, projectId }) })).json();

  it("is null (anything goes) for the open workflow", async () => {
    const w = await world();
    expect(await moves(w.projectId)).toEqual({ default: null, byType: {} });
  });

  it("lists where each status leads, keeping item-dependent moves and dropping ones the person can never take", async () => {
    const w = await world();
    await customWorkflow(w.projectId, {
      ...GOVERNED,
      transitions: [
        ...GOVERNED.transitions,
        // OWNER only: an admin can never take it, whatever the item.
        { id: "skip", name: "Skip ahead", from: ["todo"], to: "done", restrict: { kind: "actorOrgRole", in: ["OWNER"] } },
      ],
    });
    await customWorkflow(w.projectId, { ...GOVERNED, transitions: [] }, { workItemTypeId: otherTypeId });
    expect(await moves(w.projectId)).toEqual({
      // "start" depends on who is assigned: possible. "abandon" is hidden.
      default: { todo: ["doing"], doing: ["done"], done: ["todo"], cancelled: [] },
      byType: { [otherTypeId]: { todo: [], doing: [], done: [], cancelled: [] } },
    });
  });
});

describe("what a caller who can't see the project gets", () => {
  const list = async (projectId: string, itemId: string) =>
    (await getTransitions(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId, projectId, itemId }) })).status;

  it("is refused for a key scoped to another project, and can't tell a real item from a missing one", async () => {
    const w = await world();
    const elsewhere = await world();
    const a = await item(w.projectId);
    actAs(aliceId);
    calls.ctx = { ...(calls.ctx as AuthContext), isApiKey: true, scopes: ["items:write"], projectScope: [elsewhere.projectId] };
    expect(await list(w.projectId, a)).toBe(403);
    expect(await list(w.projectId, "00000000-0000-4000-8000-000000000000")).toBe(403);
    expect((await put(w.projectId, a, { columnKey: "doing" })).status).toBe(403);
    expect(await columnOf(a)).toBe("todo");
    // The same key scoped to this project gets the list.
    calls.ctx = { ...(calls.ctx as AuthContext), projectScope: [w.projectId] };
    expect(await list(w.projectId, a)).toBe(200);
  });

  it("is refused for a member outside a team-scoped project", async () => {
    const w = await world();
    await prisma.project.update({ where: { id: w.projectId }, data: { teamScopedAccess: true } });
    const a = await item(w.projectId);
    calls.ctx = { userId: bobId, orgId, orgRole: OrgRole.MEMBER, permissions: ADMIN, basePermissions: ADMIN, abacRules: [] } satisfies AuthContext;
    expect(await list(w.projectId, a)).toBe(403);
    expect((await put(w.projectId, a, { columnKey: "doing" })).status).toBe(403);
    expect(await columnOf(a)).toBe("todo");
  });
});

describe("another org's things named in a change", () => {
  let foreignOrgId = "";
  let foreignTypeId = "";
  let foreignFieldKey = "";
  beforeAll(async () => {
    const stamp = Math.random().toString(36).slice(2, 8);
    foreignOrgId = (await prisma.organization.create({ data: { name: `wfe-foreign ${stamp}`, slug: `wfe-foreign-${stamp}` } })).id;
    foreignTypeId = (await prisma.workItemType.create({ data: { orgId: foreignOrgId, key: `secret-${stamp}`, name: "Secret" } })).id;
    foreignFieldKey = `foreign_secret_${stamp}`;
    const field = await prisma.customField.create({
      data: { orgId: foreignOrgId, name: "Foreign secret", key: foreignFieldKey, fieldType: "SELECT", options: ["classified"] },
    });
    await prisma.workItemTypeField.create({ data: { workItemTypeId: foreignTypeId, customFieldId: field.id, required: true } });
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: foreignOrgId } }).catch(() => undefined);
  });

  it("a type of another org is not found, and its required fields are never listed", async () => {
    const w = await world();
    const a = await item(w.projectId);
    const r = await put(w.projectId, a, { workItemTypeId: foreignTypeId, columnKey: "doing" });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain(foreignFieldKey);
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ columnKey: "todo", workItemTypeId: typeId });
  });
});

describe("what a transition writes", () => {
  /** todo -> doing asks for a team, an interval, an assignee and a priority. */
  const ASKS: WorkflowDefinition = {
    schemaVersion: 1,
    statuses: GOVERNED.statuses,
    transitions: [
      {
        id: "start", name: "Start", from: ["todo"], to: "doing",
        input: (["teamId", "intervalId", "assigneeId", "priority"] as const).map((system) => ({ field: { system }, required: false })),
      },
      { id: "hand-off", name: "Hand off", from: ["doing"], to: "done", actions: [{ kind: "assign", to: "creator" }] },
    ],
  };
  let outsiderId = "";
  beforeAll(async () => {
    outsiderId = (await prisma.user.create({ data: { email: `outsider-${Math.random().toString(36).slice(2, 8)}@test.local`, displayName: "Outsider" } })).id;
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: outsiderId } }).catch(() => undefined);
  });

  const start = (projectId: string, itemId: string, input: Record<string, unknown>) =>
    put(projectId, itemId, { columnKey: "doing", transition: { input } });

  it("is held to the project's teams and intervals, the org's people and the patch schema", async () => {
    const w = await world();
    const elsewhere = await world();
    await customWorkflow(w.projectId, ASKS);
    const foreignTeam = await prisma.team.create({ data: { orgId, projectId: elsewhere.projectId, name: "Elsewhere" } });
    const foreignInterval = await prisma.interval.create({
      data: { orgId, projectId: elsewhere.projectId, number: 1, name: "S1", startDate: new Date(), endDate: new Date() },
    });
    const a = await item(w.projectId);

    for (const [input, field] of [
      [{ "system:teamId": foreignTeam.id }, "teamId"],
      [{ "system:intervalId": foreignInterval.id }, "intervalId"],
      [{ "system:assigneeId": outsiderId }, "assigneeId"],
      [{ "system:priority": "NOT_A_PRIORITY" }, "priority"],
    ] as const) {
      const r = await start(w.projectId, a, input);
      expect(r.status, field).toBe(422);
      expect(r.body, field).toMatchObject({ code: "transition_invalid", reasons: [{ validator: "input", fields: [{ system: field }] }] });
    }
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: a } })).toMatchObject({
      columnKey: "todo", teamId: null, intervalId: null, assigneeId: null,
    });

    // The project's own, and a member of the org, go through.
    const team = await prisma.team.create({ data: { orgId, projectId: w.projectId, name: "Here" } });
    const ok = await start(w.projectId, a, { "system:teamId": team.id, "system:assigneeId": bobId, "system:priority": "HIGH" });
    expect(ok.status).toBe(200);
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ columnKey: "doing", teamId: team.id, assigneeId: bobId });
  });

  it("refuses an action that assigns someone outside the org", async () => {
    const w = await world();
    await customWorkflow(w.projectId, {
      ...ASKS,
      transitions: ASKS.transitions.map((t) => (t.id === "hand-off" ? { ...t, actions: [{ kind: "assign" as const, to: { userId: outsiderId } }] } : t)),
    });
    const a = await item(w.projectId, { columnKey: "doing" });
    const r = await put(w.projectId, a, { columnKey: "done" });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: "transition_invalid", reasons: [{ fields: [{ system: "assigneeId" }] }] });
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ columnKey: "doing", assigneeId: null });
  });
});

describe("a bulk edit across types", () => {
  it("loads the actor's project role when a later type's workflow needs it", async () => {
    const w = await world();
    const member = await prisma.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId, userId: aliceId } } });
    await prisma.projectMember.create({ data: { projectId: w.projectId, orgMemberId: member.id, role: "LEAD" } });
    const only = (restrict: NonNullable<WorkflowDefinition["transitions"][number]["restrict"]>): WorkflowDefinition => ({
      ...GOVERNED,
      transitions: [{ id: "start", name: "Start", from: ["todo"], to: "doing", restrict }],
    });
    // The first item's workflow asks nothing of the project; the second's does.
    await customWorkflow(w.projectId, only({ kind: "actorOrgRole", in: ["ADMIN"] }), { workItemTypeId: typeId });
    await customWorkflow(w.projectId, only({ kind: "actorProjectRole", in: ["LEAD"] }), { workItemTypeId: otherTypeId });
    const a = await item(w.projectId);
    const b = await item(w.projectId, { workItemTypeId: otherTypeId });
    const res = await bulkPut(
      new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ ids: [a, b], update: { columnKey: "doing" } }) }),
      { params: Promise.resolve({ orgId, projectId: w.projectId }) },
    );
    const body = await res.json();
    expect(body).toMatchObject({ updated: 2, denied: [] });
    expect([await columnOf(a), await columnOf(b)]).toEqual(["doing", "doing"]);
  });
});

describe("a stored definition that doesn't parse", () => {
  it("runs the open workflow instead of blocking every edit", async () => {
    const w = await world();
    const wf = await prisma.workflow.create({ data: { orgId, projectId: w.projectId, name: "corrupt", createdById: aliceId } });
    const version = await prisma.workflowVersion.create({
      data: { orgId, workflowId: wf.id, version: 1, state: "PUBLISHED", definition: { schemaVersion: 1, statuses: "garbled" }, checksum: "x" },
    });
    await prisma.workflow.update({ where: { id: wf.id }, data: { publishedVersionId: version.id } });
    await prisma.workflowAssignment.create({ data: { orgId, projectId: w.projectId, workItemTypeId: null, workflowId: wf.id } });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const a = await item(w.projectId);
      expect((await put(w.projectId, a, { columnKey: "done" })).status).toBe(200);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(version.id), expect.anything());
    } finally {
      log.mockRestore();
    }
  });
});

describe("concurrent moves", () => {
  /** A change held open until `release` is called, so another can run against it. */
  function held(projectId: string, itemId: string, patch: Record<string, unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let applied!: () => void;
    const ready = new Promise<void>((r) => (applied = r));
    const done = prisma.$transaction(async (tx) => {
      await applyWorkItemChange(tx, { actorId: aliceId, orgId, projectId, itemIds: [itemId], patch, source: "API", actor: calls.ctx as AuthContext });
      applied();
      await gate;
    }, { timeout: 15_000 });
    return { ready, release, done };
  }
  const settledWithin = async (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  const move = (projectId: string, itemId: string, columnKey: string) =>
    prisma.$transaction((tx) =>
      applyWorkItemChange(tx, { actorId: aliceId, orgId, projectId, itemIds: [itemId], patch: { columnKey }, source: "API", actor: calls.ctx as AuthContext }),
    );

  it("take turns into a hard-WIP column, so two can't both fill its last place", async () => {
    const w = await world({ boardConfig: { wipHardEnforce: true }, wipLimit: 1 });
    const a = await item(w.projectId);
    const b = await item(w.projectId);
    const first = held(w.projectId, a, { columnKey: "doing" });
    await first.ready;
    const second = move(w.projectId, b, "doing");
    expect(await settledWithin(second, 400)).toBe(false);
    first.release();
    await first.done;
    await expect(second).rejects.toMatchObject({ body: { code: "transition_invalid" } });
    expect([await columnOf(a), await columnOf(b)]).toEqual(["doing", "todo"]);
  });

  it("two bulk moves of the same items in opposite orders both finish, without a deadlock", async () => {
    const w = await world({ boardConfig: { wipHardEnforce: true }, wipLimit: 50 });
    const p1 = await item(w.projectId);
    const p2 = await item(w.projectId);
    const ids = [await item(w.projectId, { parentId: p1 }), await item(w.projectId, { parentId: p2 }), await item(w.projectId), await item(w.projectId)];
    const bulk = (itemIds: string[], columnKey: string) =>
      prisma.$transaction((tx) =>
        applyWorkItemChange(tx, { actorId: aliceId, orgId, projectId: w.projectId, itemIds, patch: { columnKey }, source: "BULK", actor: calls.ctx as AuthContext }),
      );
    for (let round = 0; round < 8; round++) {
      const to = round % 2 === 0 ? "doing" : "todo";
      const results = await Promise.allSettled([bulk(ids, to), bulk([...ids].reverse(), to), bulk([ids[1], ids[3], ids[0], ids[2]], to)]);
      expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    }
    expect(new Set(await Promise.all(ids.map(columnOf)))).toEqual(new Set(["todo"]));
  });

  it("a merge and a bulk move of the same two items, in the other order, both finish", async () => {
    const w = await world({ boardConfig: { wipHardEnforce: true }, wipLimit: 50 });
    for (let round = 0; round < 6; round++) {
      // The duplicate sorts first, so a bulk move locks it before the survivor,
      // while the merge writes the survivor (its description) before the duplicate.
      const pair = [await item(w.projectId, { description: "from the duplicate" }), await item(w.projectId)].sort();
      const [dup, survivor] = pair;
      await prisma.workItem.update({ where: { id: survivor }, data: { description: "" } });
      await prisma.workItem.update({ where: { id: dup }, data: { description: "from the duplicate" } });
      const results = await Promise.allSettled([
        prisma.$transaction((tx) => mergeWorkItems(tx, { orgId, projectId: w.projectId, duplicateId: dup, survivorId: survivor, userId: aliceId })),
        prisma.$transaction((tx) =>
          applyWorkItemChange(tx, { actorId: aliceId, orgId, projectId: w.projectId, itemIds: [dup, survivor], patch: { columnKey: "doing" }, source: "BULK", actor: calls.ctx as AuthContext }),
        ),
      ]);
      expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)), `round ${round}`).toEqual([]);
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id: dup } })).mergedIntoId).toBe(survivor);
    }
  });

  it("finishing a parent waits for a sub-item being reopened, and then sees it open", async () => {
    const w = await world();
    const parent = await item(w.projectId);
    const child = await item(w.projectId, { parentId: parent, columnKey: "done" });
    const reopen = held(w.projectId, child, { columnKey: "todo" });
    await reopen.ready;
    const finish = move(w.projectId, parent, "done");
    expect(await settledWithin(finish, 400)).toBe(false);
    reopen.release();
    await reopen.done;
    await expect(finish).rejects.toMatchObject({ body: { code: "transition_invalid" } });
    expect(await columnOf(parent)).toBe("todo");
  });
});
