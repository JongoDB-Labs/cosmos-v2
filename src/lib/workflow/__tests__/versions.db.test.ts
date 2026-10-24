// @vitest-environment node
//
// Workflow P3: forking, drafts, publishing, the migration job, assignments,
// restore, templates and simulate, against the real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { OrgRole, type ColumnCategory } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn(async () => undefined) }));

import { seedBoardColumns } from "../provision.server";
import {
  assignWorkflow,
  createTemplateFrom,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  previewPublish,
  publishDraft,
  restoreVersion,
  saveDraft,
} from "../versions.server";
import { migrateProject, pendingMigrations } from "../migrate.server";
import { simulateTransitions } from "../engine.server";
import { applyWorkItemChange } from "@/lib/work-items/apply-change.server";
import type { WorkflowDefinition } from "../definition";

let orgId = "";
let aliceId = "";
let bobId = "";
let typeId = "";
let otherTypeId = "";
let ticket = 0;

const ALL = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);
const ctxOf = (userId: string, role: OrgRole = OrgRole.ADMIN): AuthContext => ({
  userId, orgId, orgRole: role, permissions: ALL & ~Permission.WORKFLOW_OVERRIDE, basePermissions: ALL, abacRules: [],
});

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  bobId = (await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `wfv ${stamp}`, slug: `wfv-${stamp}` } })).id;
  await prisma.orgMember.createMany({ data: [{ orgId, userId: aliceId, role: "ADMIN" }, { orgId, userId: bobId, role: "MEMBER" }] });
  typeId = (await prisma.workItemType.create({ data: { orgId, key: `bug-${stamp}`, name: "Bug" } })).id;
  otherTypeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

const STATUSES: { key: string; name: string; category: ColumnCategory }[] = [
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "doing", name: "Doing", category: "IN_PROGRESS" },
  { key: "review", name: "Review", category: "IN_PROGRESS" },
  { key: "done", name: "Done", category: "DONE" },
  { key: "cancelled", name: "Cancelled", category: "CANCELLED" },
];

async function project() {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const p = await prisma.project.create({ data: { orgId, name: `V ${suffix}`, key: `V${suffix}` } });
  const board = await prisma.board.create({ data: { orgId, projectId: p.id, name: "Board", type: "KANBAN" } });
  await prisma.$transaction((tx) => seedBoardColumns(tx, board, STATUSES));
  return p.id;
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

const tx = <T>(fn: (t: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) => prisma.$transaction(fn);
const scopeOf = (projectId: string) => ({ orgId, projectId });
const columnOf = async (id: string) => (await prisma.workItem.findUniqueOrThrow({ where: { id } })).columnKey;
const move = (projectId: string, itemId: string, columnKey: string) =>
  tx((t) => applyWorkItemChange(t, { actorId: aliceId, orgId, projectId, itemIds: [itemId], patch: { columnKey }, source: "API", actor: ctxOf(aliceId) }));

/** A draft from the open workflow, edited by `edit`, then published and made the project default. */
async function liveWorkflow(projectId: string, edit: (d: WorkflowDefinition) => WorkflowDefinition = (d) => d) {
  const id = await tx((t) => createWorkflow(t, { orgId, projectId, actorId: aliceId, name: `wf ${Math.random()}`, from: { kind: "open" } }));
  const wf = await tx((t) => getWorkflow(t, scopeOf(projectId), id));
  await tx((t) => saveDraft(t, scopeOf(projectId), id, { definition: edit(wf.draft!.definition as WorkflowDefinition) }));
  await tx((t) => publishDraft(t, scopeOf(projectId), id, { actorId: aliceId }));
  await tx((t) => assignWorkflow(t, { orgId, projectId, workItemTypeId: null, workflowId: id }));
  return id;
}

const without = (d: WorkflowDefinition, key: string): WorkflowDefinition => ({
  ...d,
  statuses: d.statuses.filter((s) => s.key !== key),
  transitions: d.transitions.filter((t) => t.to !== key),
});

describe("forking the open workflow", () => {
  it("starts a draft with every status, a move into each, and today's checks", async () => {
    const p = await project();
    const id = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: "Delivery", from: { kind: "open" } }));
    const wf = await tx((t) => getWorkflow(t, scopeOf(p), id));
    const def = wf.draft!.definition as WorkflowDefinition;
    expect(def.statuses.map((s) => s.key)).toEqual(["todo", "doing", "review", "done", "cancelled"]);
    expect(def.statuses.find((s) => s.isInitial)?.key).toBe("todo");
    expect(def.transitions.find((t) => t.to === "done")).toMatchObject({
      from: "*", validate: [{ kind: "wipLimit" }, { kind: "childrenSettled" }],
    });
    expect(def.transitions.find((t) => t.to === "cancelled")?.validate).toContainEqual({ kind: "cancelReason" });
    expect(wf.published).toBeNull();
    // It governs nothing until published and assigned.
    expect(await prisma.workflowAssignment.count({ where: { projectId: p } })).toBe(0);
  });

  it("refuses a second workflow with the same name in the project", async () => {
    const p = await project();
    await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: "Same", from: { kind: "open" } }));
    await expect(
      tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: "Same", from: { kind: "open" } })),
    ).rejects.toMatchObject({ code: "workflow_in_use" });
  });
});

describe("the draft", () => {
  it("saves a well-formed draft with its errors listed, and refuses a malformed one", async () => {
    const p = await project();
    const id = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: "D", from: { kind: "open" } }));
    const def = (await tx((t) => getWorkflow(t, scopeOf(p), id))).draft!.definition as WorkflowDefinition;
    const noInitial = { ...def, statuses: def.statuses.map(({ key }) => ({ key })) };
    const saved = await tx((t) => saveDraft(t, scopeOf(p), id, { definition: noInitial }));
    expect(saved.version).toBe(1);
    expect(saved.issues).toContainEqual(expect.objectContaining({ severity: "error", code: "INITIAL_STATUS" }));
    await expect(tx((t) => saveDraft(t, scopeOf(p), id, { definition: { schemaVersion: 2 } }))).rejects.toMatchObject({
      code: "workflow_invalid",
    });
    // And a draft with errors is not published.
    await expect(tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }))).rejects.toMatchObject({
      code: "workflow_invalid",
      extensions: { issues: [expect.objectContaining({ code: "INITIAL_STATUS" })] },
    });
  });

  it("is the next version after a publish, and restoring an old version drafts its definition", async () => {
    const p = await project();
    const id = await liveWorkflow(p);
    const v1 = (await tx((t) => getWorkflow(t, scopeOf(p), id))).published!.definition as WorkflowDefinition;
    const saved = await tx((t) => saveDraft(t, scopeOf(p), id, { definition: without(v1, "review") }));
    expect(saved.version).toBe(2);
    await tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }));
    const restored = await tx((t) => restoreVersion(t, scopeOf(p), id, 1));
    expect(restored.version).toBe(3);
    const wf = await tx((t) => getWorkflow(t, scopeOf(p), id));
    expect((wf.draft!.definition as WorkflowDefinition).statuses.map((s) => s.key)).toContain("review");
    expect(wf.versions.map((v) => [v.version, v.state])).toEqual([[3, "DRAFT"], [2, "PUBLISHED"], [1, "SUPERSEDED"]]);
  });
});

describe("publishing", () => {
  it("governs moves once published and assigned", async () => {
    const p = await project();
    const a = await item(p);
    await liveWorkflow(p, (d) => ({ ...d, transitions: d.transitions.filter((t) => t.to !== "review") }));
    await expect(move(p, a, "review")).rejects.toMatchObject({ body: { code: "transition_not_allowed" } });
    await move(p, a, "doing");
    expect(await columnOf(a)).toBe("doing");
  });

  it("needs a map for a dropped status that holds items, then moves them in the background", async () => {
    const p = await project();
    const id = await liveWorkflow(p);
    const inReview = [await item(p, { columnKey: "review" }), await item(p, { columnKey: "review" }), await item(p, { columnKey: "review" })];
    const keep = await item(p, { columnKey: "doing" });
    const v1 = (await tx((t) => getWorkflow(t, scopeOf(p), id))).published!.definition as WorkflowDefinition;
    await tx((t) => saveDraft(t, scopeOf(p), id, { definition: without(v1, "review") }));

    const preview = await tx((t) => previewPublish(t, scopeOf(p), id));
    expect(preview.diff.removedStatuses).toEqual([{ key: "review", items: 3 }]);
    expect(preview.diff.removedTransitions.map((t) => t.id)).toEqual(["review"]);

    await expect(tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }))).rejects.toMatchObject({
      code: "migration_map_required",
      extensions: { statuses: [{ key: "review", items: 3 }] },
    });
    // A map into a status the new version doesn't have is no map.
    await expect(
      tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId, migrationMap: { review: "review" } })),
    ).rejects.toMatchObject({ code: "migration_map_required" });

    const published = await tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId, migrationMap: { review: "done" } }));
    expect(published.migrationMap).toEqual({ review: "done" });
    expect(await pendingMigrations(prisma, p)).toEqual([
      expect.objectContaining({ from: "review", to: "done", items: 3, workItemTypeId: null }),
    ]);

    // Two batches of two, so the job's loop is exercised.
    expect(await migrateProject(prisma, { orgId, projectId: p, batch: 2 })).toBe(3);
    for (const i of inReview) expect(await columnOf(i)).toBe("done");
    expect(await columnOf(keep)).toBe("doing");
    // A move like any other: the dates a status change sets, and an Activity row.
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: inReview[0] } })).completedAt).not.toBeNull();
    expect(await prisma.activity.count({ where: { workItemId: inReview[0], field: "columnKey" } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { subjectId: inReview[0], source: "MIGRATION" } })).toBe(1);
    expect(await pendingMigrations(prisma, p)).toEqual([]);
    // Resumable and idempotent: nothing left, nothing moves.
    expect(await migrateProject(prisma, { orgId, projectId: p })).toBe(0);
  });

  it("keeps the last publish's map for items not yet moved, following it into the next one", async () => {
    const p = await project();
    const id = await liveWorkflow(p);
    const inReview = await item(p, { columnKey: "review" });
    const inDoing = await item(p, { columnKey: "doing" });
    const v1 = (await tx((t) => getWorkflow(t, scopeOf(p), id))).published!.definition as WorkflowDefinition;
    await tx((t) => saveDraft(t, scopeOf(p), id, { definition: without(v1, "review") }));
    await tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId, migrationMap: { review: "doing" } }));
    // Before the job runs, Doing goes too, its items to To Do.
    const v2 = (await tx((t) => getWorkflow(t, scopeOf(p), id))).published!.definition as WorkflowDefinition;
    await tx((t) => saveDraft(t, scopeOf(p), id, { definition: without(v2, "doing") }));
    const v3 = await tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId, migrationMap: { doing: "todo" } }));
    expect(v3.migrationMap).toEqual({ review: "doing", doing: "todo" });
    expect(await pendingMigrations(prisma, p)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "review", to: "todo", items: 1 }),
        expect.objectContaining({ from: "doing", to: "todo", items: 1 }),
      ]),
    );
    expect(await migrateProject(prisma, { orgId, projectId: p })).toBe(2);
    expect(await columnOf(inReview)).toBe("todo");
    expect(await columnOf(inDoing)).toBe("todo");
  });
});

describe("assigning a type its own workflow", () => {
  it("maps that type's items the new workflow doesn't use, and leaves other types alone", async () => {
    const p = await project();
    const bug = await item(p, { columnKey: "review" });
    const task = await item(p, { columnKey: "review", workItemTypeId: otherTypeId });
    const id = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: "Bugs", from: { kind: "open" } }));
    const def = (await tx((t) => getWorkflow(t, scopeOf(p), id))).draft!.definition as WorkflowDefinition;
    await tx((t) => saveDraft(t, scopeOf(p), id, { definition: without(def, "review") }));
    await tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }));

    await expect(
      tx((t) => assignWorkflow(t, { orgId, projectId: p, workItemTypeId: typeId, workflowId: id })),
    ).rejects.toMatchObject({ code: "migration_map_required", extensions: { statuses: [{ key: "review", items: 1 }] } });
    await tx((t) => assignWorkflow(t, { orgId, projectId: p, workItemTypeId: typeId, workflowId: id, migrationMap: { review: "doing" } }));
    expect(await migrateProject(prisma, { orgId, projectId: p })).toBe(1);
    expect(await columnOf(bug)).toBe("doing");
    expect(await columnOf(task)).toBe("review");
  });

  it("refuses an unpublished workflow, and a workflow still assigned can't be deleted", async () => {
    const p = await project();
    const draftOnly = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: "Draft", from: { kind: "open" } }));
    await expect(
      tx((t) => assignWorkflow(t, { orgId, projectId: p, workItemTypeId: null, workflowId: draftOnly })),
    ).rejects.toMatchObject({ code: "workflow_invalid" });
    const live = await liveWorkflow(p);
    await expect(tx((t) => deleteWorkflow(t, scopeOf(p), live))).rejects.toMatchObject({ code: "workflow_in_use" });
    await tx((t) => assignWorkflow(t, { orgId, projectId: p, workItemTypeId: null, workflowId: null }));
    await tx((t) => deleteWorkflow(t, scopeOf(p), live));
    expect(await prisma.workflow.count({ where: { id: live } })).toBe(0);
  });
});

describe("org templates", () => {
  it("carry a workflow and its statuses into another project, as a copy", async () => {
    const from = await project();
    await prisma.workflowStatus.create({ data: { orgId, projectId: from, key: "triage", name: "Triage", category: "TODO", color: "#123456", sortOrder: 9 } });
    // The fork already has Triage: it starts from the project's statuses.
    const id = await liveWorkflow(from);
    const template = await tx((t) => createTemplateFrom(t, { orgId, workflowId: id, name: `T ${Math.random()}`, actorId: aliceId }));

    const to = await project();
    const copy = await tx((t) => createWorkflow(t, { orgId, projectId: to, actorId: aliceId, name: "From template", from: { kind: "template", templateId: template } }));
    expect(await prisma.workflowStatus.findUnique({ where: { projectId_key: { projectId: to, key: "triage" } } })).toMatchObject({
      name: "Triage", category: "TODO", color: "#123456",
    });
    const def = (await tx((t) => getWorkflow(t, scopeOf(to), copy))).draft!.definition as WorkflowDefinition;
    expect(def.statuses.map((s) => s.key)).toContain("triage");
    // A copy: editing it leaves the template as it was.
    await tx((t) => saveDraft(t, scopeOf(to), copy, { definition: without(def, "triage") }));
    const kept = await tx((t) => getWorkflow(t, { orgId, projectId: null }, template));
    expect((kept.published!.definition as WorkflowDefinition).statuses.map((s) => s.key)).toContain("triage");
  });
});

describe("drafts and publishes at once", () => {
  /** `fn` in a transaction held open after it runs, until `release`. */
  function held(fn: (t: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ran!: () => void;
    const ready = new Promise<void>((r) => (ran = r));
    const done = prisma.$transaction(async (t) => {
      await fn(t);
      ran();
      await gate;
    }, { timeout: 15_000 });
    return { ready, release, done };
  }
  const settledWithin = (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  it("an autosave during a publish waits, then becomes the next draft, never the published version", async () => {
    const p = await project();
    const id = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: `race ${Math.random()}`, from: { kind: "open" } }));
    const def = (await tx((t) => getWorkflow(t, scopeOf(p), id))).draft!.definition as WorkflowDefinition;
    const publish = held((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }));
    await publish.ready;
    const save = tx((t) => saveDraft(t, scopeOf(p), id, { definition: without(def, "review") }));
    expect(await settledWithin(save, 300)).toBe(false);
    publish.release();
    await publish.done;
    expect(await save).toMatchObject({ version: 2 });
    const versions = await prisma.workflowVersion.findMany({ where: { workflowId: id }, orderBy: { version: "asc" } });
    expect(versions.map((v) => [v.version, v.state])).toEqual([[1, "PUBLISHED"], [2, "DRAFT"]]);
    expect((versions[0].definition as WorkflowDefinition).statuses.map((x) => x.key)).toContain("review");
  });

  it("two assignments of a project's default at once: the second is a 409, not a server error", async () => {
    const p = await project();
    const a = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: `A ${Math.random()}`, from: { kind: "open" } }));
    const b = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: `B ${Math.random()}`, from: { kind: "open" } }));
    for (const id of [a, b]) await tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }));
    const first = held((t) => assignWorkflow(t, { orgId, projectId: p, workItemTypeId: null, workflowId: a }));
    await first.ready;
    const second = tx((t) => assignWorkflow(t, { orgId, projectId: p, workItemTypeId: null, workflowId: b }));
    // It rejects while the test waits below; handled now so vitest doesn't count it unhandled.
    second.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    first.release();
    await first.done;
    await expect(second).rejects.toMatchObject({ code: "workflow_in_use" });
    expect(await prisma.workflowAssignment.findMany({ where: { projectId: p }, select: { workflowId: true } })).toEqual([{ workflowId: a }]);
  });

  it("deleting a workflow while it is being assigned: the delete is a 409, and the workflow stays", async () => {
    const p = await project();
    const id = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: `D ${Math.random()}`, from: { kind: "open" } }));
    await tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }));
    const assign = held((t) => assignWorkflow(t, { orgId, projectId: p, workItemTypeId: null, workflowId: id }));
    await assign.ready;
    const remove = tx((t) => deleteWorkflow(t, scopeOf(p), id));
    // It rejects while the test waits below; handled now so vitest doesn't count it unhandled.
    remove.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    assign.release();
    await assign.done;
    await expect(remove).rejects.toMatchObject({ code: "workflow_in_use" });
    expect(await prisma.workflow.count({ where: { id } })).toBe(1);
  });

  it("two publishes of one draft: the second finds nothing left to publish", async () => {
    const p = await project();
    const id = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: `race2 ${Math.random()}`, from: { kind: "open" } }));
    const first = held((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }));
    await first.ready;
    const second = tx((t) => publishDraft(t, scopeOf(p), id, { actorId: bobId }));
    expect(await settledWithin(second, 300)).toBe(false);
    first.release();
    await first.done;
    await expect(second).rejects.toThrow(/no draft to publish/);
    const versions = await prisma.workflowVersion.findMany({ where: { workflowId: id } });
    expect(versions.map((v) => [v.state, v.publishedById])).toEqual([["PUBLISHED", aliceId]]);
  });
});

describe("names", () => {
  it("two templates saved at once under one name: the second is refused, not a server error", async () => {
    const p = await project();
    const id = await liveWorkflow(p);
    const name = `Same ${Math.random()}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let created!: () => void;
    const ready = new Promise<void>((r) => (created = r));
    // The first save is open when the second checks the name, so the check passes and the index decides.
    const first = prisma.$transaction(async (t) => {
      await createTemplateFrom(t, { orgId, workflowId: id, name, actorId: aliceId });
      created();
      await gate;
    }, { timeout: 15_000 });
    await ready;
    const second = tx((t) => createTemplateFrom(t, { orgId, workflowId: id, name, actorId: aliceId }));
    // It rejects while the test waits below; handled now so vitest doesn't count it unhandled.
    second.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    release();
    await first;
    await expect(second).rejects.toMatchObject({ code: "workflow_in_use" });
    expect(await prisma.workflow.count({ where: { orgId, projectId: null, name } })).toBe(1);
  });
});

describe("publishing what actions name", () => {
  it("refuses an assignee outside the org, and a team or interval of another project", async () => {
    const p = await project();
    const elsewhere = await project();
    const outsider = await prisma.user.create({ data: { email: `wfv-out-${Math.random().toString(36).slice(2, 8)}@test.local`, displayName: "Outsider" } });
    const team = await prisma.team.create({ data: { orgId, projectId: elsewhere, name: "Elsewhere" } });
    const interval = await prisma.interval.create({ data: { orgId, projectId: elsewhere, number: 1, name: "S1", startDate: new Date(), endDate: new Date() } });
    try {
      const id = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: `refs ${Math.random()}`, from: { kind: "open" } }));
      const def = (await tx((t) => getWorkflow(t, scopeOf(p), id))).draft!.definition as WorkflowDefinition;
      const withActions = (actions: NonNullable<WorkflowDefinition["transitions"][number]["actions"]>): WorkflowDefinition => ({
        ...def,
        transitions: def.transitions.map((t) => (t.to === "doing" ? { ...t, actions } : t)),
      });
      for (const [actions, code] of [
        [[{ kind: "assign", to: { userId: outsider.id } }], "UNKNOWN_ASSIGNEE"],
        [[{ kind: "setField", field: { system: "teamId" }, value: { literal: team.id } }], "UNKNOWN_TEAM"],
        [[{ kind: "setField", field: { system: "intervalId" }, value: { literal: interval.id } }], "UNKNOWN_INTERVAL"],
      ] as const) {
        await tx((t) => saveDraft(t, scopeOf(p), id, { definition: withActions(actions as never) }));
        await expect(tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId })), code).rejects.toMatchObject({
          code: "workflow_invalid", extensions: { issues: [expect.objectContaining({ code })] },
        });
      }
      // A restriction to a team of another project, or a custom field the org doesn't have.
      await tx((t) => saveDraft(t, scopeOf(p), id, {
        definition: { ...def, transitions: def.transitions.map((t) => (t.to === "doing" ? { ...t, restrict: { kind: "actorInTeam" as const, teamId: team.id } } : t)) },
      }));
      await expect(tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }))).rejects.toMatchObject({
        extensions: { issues: [expect.objectContaining({ code: "UNKNOWN_TEAM" })] },
      });
      await tx((t) => saveDraft(t, scopeOf(p), id, { definition: withActions([{ kind: "clearField", field: { custom: "no_such_field" } }]) }));
      await expect(tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }))).rejects.toMatchObject({
        extensions: { issues: [expect.objectContaining({ code: "UNKNOWN_FIELD" })] },
      });
      // A member of the org is fine.
      await tx((t) => saveDraft(t, scopeOf(p), id, { definition: withActions([{ kind: "assign", to: { userId: bobId } }]) }));
      await expect(tx((t) => publishDraft(t, scopeOf(p), id, { actorId: aliceId }))).resolves.toMatchObject({ version: 1 });
    } finally {
      await prisma.user.delete({ where: { id: outsider.id } }).catch(() => undefined);
    }
  });
});

describe("simulate", () => {
  it("says what each transition would do for an actor, under a draft too", async () => {
    const p = await project();
    const parent = await item(p, { columnKey: "doing", resolution: null });
    await item(p, { parentId: parent });
    const id = await tx((t) => createWorkflow(t, { orgId, projectId: p, actorId: aliceId, name: "Sim", from: { kind: "open" } }));
    const base = (await tx((t) => getWorkflow(t, scopeOf(p), id))).draft!.definition as WorkflowDefinition;
    const draft: WorkflowDefinition = {
      ...base,
      transitions: [
        { id: "back", name: "Back", from: ["doing"], to: "todo" },
        { id: "review", name: "Review", from: ["doing"], to: "review", restrict: { kind: "actorIsAssignee" } },
        { id: "finish", name: "Finish", from: ["doing"], to: "done", validate: [{ kind: "childrenSettled" }] },
        { id: "abandon", name: "Abandon", from: "*", to: "cancelled", hidden: true },
        { id: "resolve", name: "Resolve", from: ["doing"], to: "done", input: [{ field: { system: "resolution" }, required: true }] },
      ],
    };
    const item0 = await prisma.workItem.findUniqueOrThrow({ where: { id: parent } });
    const r = await tx((t) => simulateTransitions(t, { orgId, projectId: p, actor: ctxOf(bobId, OrgRole.MEMBER), item: item0, definition: draft }));
    const by = Object.fromEntries(r.transitions.map((t) => [t.id, t.outcome]));
    expect(by).toEqual({ back: "available", review: "restricted", finish: "blocked", abandon: "hidden", resolve: "needs_input" });
    expect(r.transitions.find((t) => t.id === "finish")!.reasons[0]).toMatch(/sub-items/);

    expect(r.transitions.find((t) => t.id === "resolve")!.reasons).toEqual(["Asks for Resolution."]);

    // Once the child is settled, Finish is open.
    await prisma.workItem.updateMany({ where: { parentId: parent }, data: { columnKey: "done" } });
    const r2 = await tx((t) => simulateTransitions(t, { orgId, projectId: p, actor: ctxOf(bobId, OrgRole.MEMBER), item: item0, definition: draft }));
    expect(r2.transitions.find((t) => t.id === "finish")).toMatchObject({ outcome: "available" });
  });
});
