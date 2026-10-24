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
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn() }));
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

  it("holds a board's hard WIP limit when the move comes from that board", async () => {
    const w = await world({ boardConfig: { wipHardEnforce: true }, wipLimit: 1 });
    await item(w.projectId, { columnKey: "doing" });
    const b = await item(w.projectId);
    const refused = await put(w.projectId, b, { columnKey: "doing", boardId: w.boardId });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "transition_invalid", reasons: [{ validator: "wipLimit" }] });
    // Not from that board (the detail sheet, the API): the board's limit is the board's.
    expect((await put(w.projectId, b, { columnKey: "doing" })).status).toBe(200);
  });

  it("does not hold a soft WIP limit", async () => {
    const w = await world({ wipLimit: 1 });
    await item(w.projectId, { columnKey: "doing" });
    const b = await item(w.projectId);
    expect((await put(w.projectId, b, { columnKey: "doing", boardId: w.boardId })).status).toBe(200);
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
