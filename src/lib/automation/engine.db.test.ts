// @vitest-environment node
//
// Workflow P4b: the automation rule engine against a real database. Changes go
// through the outbox worker exactly as in production; the rules then act as
// their owner, capped, through the same writer and workflow as a person.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { ColumnCategory } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { maskToDb, Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { applyWorkItemChange } from "@/lib/work-items/apply-change.server";
import { createWorkItemRow } from "@/lib/work-items/write.server";
import { seedBoardColumns } from "@/lib/workflow/provision.server";
import { processOutboxBatch } from "./outbox.server";
import { runDueSchedules, runRulesForEvents, RULE_RUNS_PER_5_MIN, type RuleEvent } from "./engine.server";
import { createRule, ruleWarnings, updateRule } from "./rules.server";
import { automationUserId } from "./principal.server";
import { AUTOMATION_LIMITS, type AutomationSpec } from "./spec";
import { AUTOMATION_TEMPLATES, templateByKey, type AutomationTemplate } from "./templates";

let orgId = "";
let aliceId = "";
let bobId = "";
let typeId = "";
let ticket = 0;
const ALL = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);

const STATUSES: { key: string; name: string; category: ColumnCategory }[] = [
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "doing", name: "Doing", category: "IN_PROGRESS" },
  { key: "done", name: "Done", category: "DONE" },
  { key: "cancelled", name: "Cancelled", category: "CANCELLED" },
];

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  bobId = (await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `au ${stamp}`, slug: `au-${stamp}` } })).id;
  await prisma.orgMember.createMany({ data: [{ orgId, userId: aliceId, role: "ADMIN" }, { orgId, userId: bobId, role: "MEMBER" }] });
  typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

beforeEach(async () => {
  await prisma.automationRule.deleteMany({ where: { orgId } });
  await prisma.domainEvent.updateMany({ where: { orgId, processedAt: null }, data: { processedAt: new Date() } });
  // Back in the org, whatever a test did.
  await prisma.orgMember.upsert({ where: { orgId_userId: { orgId, userId: aliceId } }, create: { orgId, userId: aliceId, role: "ADMIN" }, update: { role: "ADMIN", removedAt: null } });
});

async function project() {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const p = await prisma.project.create({ data: { orgId, name: `A ${suffix}`, key: `A${suffix}` } });
  const board = await prisma.board.create({ data: { orgId, projectId: p.id, name: "Board", type: "KANBAN" } });
  await prisma.$transaction((tx) => seedBoardColumns(tx, board, STATUSES));
  return p.id;
}

async function item(projectId: string, extra: Record<string, unknown> = {}) {
  const row = await createWorkItemRow(
    prisma,
    { data: { orgId, projectId, workItemTypeId: typeId, createdById: aliceId, title: `Item ${++ticket}`, description: "", columnKey: "todo", ticketNumber: ticket, ...extra }, select: { id: true } },
    { actorId: aliceId, source: "API" },
  );
  return row.id;
}

const aliceCtx = async () => (await loadMemberAuthContext(orgId, aliceId))!;

async function move(projectId: string, id: string, columnKey: string, by = aliceId) {
  const actor: AuthContext = (await loadMemberAuthContext(orgId, by))!;
  await prisma.$transaction((tx) => applyWorkItemChange(tx, { orgId, projectId, actorId: by, actor, source: "API", itemIds: [id], patch: { columnKey } }));
}

/** A rule straight into the table, owned by alice with her full access unless told otherwise. */
function rule(projectId: string | null, spec: AutomationSpec | Record<string, unknown>, over: Record<string, unknown> = {}) {
  return prisma.automationRule.create({
    data: { orgId, projectId, name: `R ${Math.random().toString(36).slice(2, 6)}`, spec: spec as object, actorCap: maskToDb(ALL), ownerId: aliceId, ...over },
  });
}

/** Drain this org's outbox, rules and all, like the worker does. */
async function settle() {
  for (let i = 0; i < 20; i++) if ((await processOutboxBatch(prisma, { orgId })).events === 0) return;
}

const runsOf = (ruleId: string) => prisma.automationRun.findMany({ where: { ruleId }, orderBy: { createdAt: "asc" } });

describe("rules fired by changes", () => {
  it("runs a rule's actions when its trigger matches, as the automation user, and records the run", async () => {
    const p = await project();
    const r = await rule(p, {
      trigger: { on: "item.transitioned", toCategory: ["DONE"] },
      actions: [{ kind: "addLabels", labels: ["shipped"] }, { kind: "addComment", body: "{{item.key}} done by {{actor.name}}" }, { kind: "assign", to: "triggerActor" }],
    });
    const id = await item(p);
    await settle();
    expect(await runsOf(r.id)).toHaveLength(0); // created, not transitioned
    await move(p, id, "doing", bobId);
    await move(p, id, "done", bobId);
    await settle();
    const runs = await runsOf(r.id);
    expect(runs.map((x) => x.status)).toEqual(["SUCCESS"]);
    expect(runs[0]).toMatchObject({ itemsMatched: 1, depth: 1 });
    const after = await prisma.workItem.findUniqueOrThrow({ where: { id }, select: { tags: true, assigneeId: true, ticketNumber: true } });
    expect(after.tags).toEqual(["shipped"]);
    expect(after.assigneeId).toBe(bobId);
    const bot = await automationUserId(orgId);
    const comment = await prisma.comment.findFirstOrThrow({ where: { workItemId: id } });
    expect(comment).toMatchObject({ authorId: bot });
    expect(comment.content).toMatch(new RegExp(`-${after.ticketNumber} done by Bob`, "i"));
    // The rule's own writes carry the chain: who caused them and how deep.
    const own = await prisma.domainEvent.findMany({ where: { subjectId: id, causedByRuleId: r.id } });
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((e) => e.depth === 1 && e.source === "AUTOMATION" && e.actorId === bot)).toBe(true);
    expect(await prisma.auditLog.count({ where: { orgId, action: "automation.rule_ran", entityId: r.id } })).toBe(1);
  });

  it("never fires on its own change: its event is SKIPPED_SELF, and nothing loops", async () => {
    const p = await project();
    const r = await rule(p, { trigger: { on: "item.updated" }, actions: [{ kind: "setField", field: "priority", value: "HIGH" }] });
    const id = await item(p);
    await prisma.$transaction(async (tx) =>
      applyWorkItemChange(tx, { orgId, projectId: p, actorId: aliceId, actor: await aliceCtx(), source: "API", itemIds: [id], patch: { storyPoints: 3 } }),
    );
    await settle();
    expect((await runsOf(r.id)).map((x) => x.status)).toEqual(["SUCCESS", "SKIPPED_SELF"]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).priority).toBe("HIGH");
  });

  it("lets an automation's change fire another rule only when that rule allows chains", async () => {
    const p = await project();
    const first = await rule(p, { trigger: { on: "item.transitioned", to: ["doing"] }, actions: [{ kind: "setField", field: "storyPoints", value: 5 }] });
    const closed = await rule(p, { trigger: { on: "item.updated", fields: ["storyPoints"] }, actions: [{ kind: "addLabels", labels: ["closed-chain"] }] });
    const open = await rule(p, { trigger: { on: "item.updated", fields: ["storyPoints"] }, actions: [{ kind: "addLabels", labels: ["open-chain"] }] }, { allowChain: true });
    const id = await item(p);
    await move(p, id, "doing");
    await settle();
    expect((await runsOf(first.id)).map((x) => x.status)).toEqual(["SUCCESS"]);
    expect(await runsOf(closed.id)).toHaveLength(0);
    expect((await runsOf(open.id)).map((x) => [x.status, x.depth])).toEqual([["SUCCESS", 2]]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).tags).toEqual(["open-chain"]);
  });

  it("acts only on items its CQL condition matches", async () => {
    const p = await project();
    const r = await rule(p, { trigger: { on: "item.created" }, condition: { cql: "priority = HIGH" }, actions: [{ kind: "addLabels", labels: ["hot"] }] });
    const hot = await item(p, { priority: "HIGH" });
    const cold = await item(p, { priority: "LOW" });
    await settle();
    expect((await runsOf(r.id)).map((x) => x.status).sort()).toEqual(["NO_MATCH", "SUCCESS"]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: hot } })).tags).toEqual(["hot"]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: cold } })).tags).toEqual([]);
    // A NO_MATCH is the run row only.
    expect(await prisma.auditLog.count({ where: { orgId, action: "automation.rule_ran", entityId: r.id } })).toBe(1);
  });

  it("acts on the parent or the children when scoped to them", async () => {
    const p = await project();
    const parent = await item(p);
    const child = await item(p, { parentId: parent });
    const r = await rule(p, { trigger: { on: "item.transitioned", to: ["doing"] }, scope: "parent", actions: [{ kind: "transition", to: "doing" }] });
    await settle();
    await move(p, child, "doing");
    await settle();
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: parent } })).columnKey).toBe("doing");
    // The parent's move was the rule's own change: it doesn't fire the rule again.
    expect((await runsOf(r.id)).map((x) => x.status)).toEqual(["SUCCESS", "SKIPPED_SELF"]);
  });

  it("moves a parent to Done only once every child is done or cancelled (childrenAll), archived ones aside, and never a childless item", async () => {
    const p = await project();
    const parent = await item(p);
    const [a, b] = [await item(p, { parentId: parent }), await item(p, { parentId: parent })];
    await item(p, { parentId: parent, archivedAt: new Date() }); // still To Do, but archived: it doesn't count
    const leaf = await item(p);
    const r = await rule(p, {
      trigger: { on: "item.transitioned", toCategory: ["DONE"] },
      scope: "parent",
      condition: { childrenAll: { categories: ["DONE", "CANCELLED"] } },
      actions: [{ kind: "transition", to: "done" }],
    });
    const self = await rule(p, {
      trigger: { on: "item.transitioned", toCategory: ["DONE"] },
      condition: { childrenAll: { categories: ["DONE"] } },
      actions: [{ kind: "addLabels", labels: ["all-children-done"] }],
    }, { allowChain: true }); // the parent's move is the other rule's
    await settle();
    const status = async (id: string) => (await prisma.workItem.findUniqueOrThrow({ where: { id } })).columnKey;
    await move(p, a, "doing");
    await move(p, a, "done");
    await settle();
    expect(await status(parent)).toBe("todo");
    expect((await runsOf(r.id)).map((x) => x.status)).toEqual(["NO_MATCH"]);
    await move(p, b, "doing");
    await move(p, b, "done");
    await settle();
    expect(await status(parent)).toBe("done");
    // A done item with no children has nothing to be all done.
    await move(p, leaf, "doing");
    await move(p, leaf, "done");
    await settle();
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: leaf } })).tags).toEqual([]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: parent } })).tags).toEqual(["all-children-done"]);
    expect((await runsOf(self.id)).map((x) => x.status).filter((s) => s === "SUCCESS")).toHaveLength(1);
  });

  it("cancels with the reason it names, and records no reason on a move that isn't a cancel", async () => {
    const p = await project();
    await rule(p, {
      trigger: { on: "item.created" },
      condition: { cql: "priority = LOW" },
      actions: [{ kind: "transition", to: "cancelled", cancel: { reason: "OBE" } }],
    });
    await rule(p, {
      trigger: { on: "item.created" },
      condition: { cql: "priority = HIGH" },
      actions: [{ kind: "transition", to: "doing", cancel: { reason: "OBE" } }],
    });
    const [stale, hot] = [await item(p, { priority: "LOW" }), await item(p, { priority: "HIGH" })];
    await settle();
    const fields = { columnKey: true, cancelReason: true } as const;
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: stale }, select: fields })).toEqual({ columnKey: "cancelled", cancelReason: "OBE" });
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: hot }, select: fields })).toEqual({ columnKey: "doing", cancelReason: null });
  });

  it("still makes its changes for an event over an hour old, but sends no notification for it", async () => {
    const p = await project();
    const r = await rule(p, {
      trigger: { on: "item.created" },
      actions: [{ kind: "addLabels", labels: ["seen"] }, { kind: "notify", to: { userIds: [bobId] }, message: "{{item.key}} is new" }],
    });
    const id = await item(p);
    await prisma.domainEvent.updateMany({ where: { subjectId: id }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    await settle();
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).tags).toEqual(["seen"]);
    expect(await prisma.notification.count({ where: { orgId, userId: bobId, refId: id } })).toBe(0);
    const [run] = await runsOf(r.id);
    expect(run.status).toBe("SUCCESS");
    expect(run.actions).toEqual([expect.objectContaining({ kind: "addLabels", ok: true }), expect.objectContaining({ kind: "notify", ok: true, skipped: "late" })]);
  });

  it("runs a rule once per event, even when the event is processed again", async () => {
    const p = await project();
    const r = await rule(p, { trigger: { on: "item.created" }, actions: [{ kind: "addComment", body: "hi" }] });
    const id = await item(p);
    await settle();
    await prisma.domainEvent.updateMany({ where: { subjectId: id }, data: { processedAt: null } });
    await settle();
    expect(await runsOf(r.id)).toHaveLength(1);
    expect(await prisma.comment.count({ where: { workItemId: id } })).toBe(1);
  });

  it("skips an import's changes unless the rule opts in", async () => {
    const p = await project();
    const off = await rule(p, { trigger: { on: "item.created" }, actions: [{ kind: "addLabels", labels: ["seen"] }] });
    const on = await rule(p, { trigger: { on: "item.created" }, options: { includeImports: true }, actions: [{ kind: "addLabels", labels: ["seen"] }] });
    await createWorkItemRow(
      prisma,
      { data: { orgId, projectId: p, workItemTypeId: typeId, createdById: aliceId, title: "imported", description: "", columnKey: "todo", ticketNumber: ++ticket }, select: { id: true } },
      { actorId: null, source: "IMPORT" },
    );
    await settle();
    expect(await runsOf(off.id)).toHaveLength(0);
    expect((await runsOf(on.id)).map((x) => x.status)).toEqual(["SUCCESS"]);
  });
});

describe("what a rule may do", () => {
  it("obeys the item's workflow: a transition the workflow refuses fails, and the run says so", async () => {
    const p = await project();
    const r = await rule(p, { trigger: { on: "item.created" }, actions: [{ kind: "transition", to: "nowhere" }, { kind: "addLabels", labels: ["tried"] }] });
    const id = await item(p);
    await settle();
    const [run] = await runsOf(r.id);
    expect(run.status).toBe("PARTIAL");
    expect(run.actions).toMatchObject([{ kind: "transition", ok: false }, { kind: "addLabels", ok: true }]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).columnKey).toBe("todo");
  });

  it("can't do more than its owner held when they saved it", async () => {
    const p = await project();
    const r = await rule(p, { trigger: { on: "item.created" }, actions: [{ kind: "addLabels", labels: ["capped"] }] }, { actorCap: maskToDb(Permission.ITEM_READ | Permission.PROJECT_READ) });
    const id = await item(p);
    await settle();
    const [run] = await runsOf(r.id);
    expect(run.status).toBe("FAILED");
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).tags).toEqual([]);
  });

  it("can't do more than its owner holds now: their access is read at every run", async () => {
    const p = await project();
    const r = await rule(p, { trigger: { on: "item.created" }, actions: [{ kind: "addLabels", labels: ["now"] }] }, { ownerId: bobId });
    // Bob is a MEMBER: he can edit items. Take that away after he saved the rule.
    await prisma.orgMember.update({ where: { orgId_userId: { orgId, userId: bobId } }, data: { role: "VIEWER" } });
    try {
      const id = await item(p);
      await settle();
      expect((await runsOf(r.id)).map((x) => x.status)).toEqual(["FAILED"]);
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).tags).toEqual([]);
    } finally {
      await prisma.orgMember.update({ where: { orgId_userId: { orgId, userId: bobId } }, data: { role: "MEMBER" } });
    }
  });

  it("is held to its owner's access policies, as the item PUT route holds them", async () => {
    const p = await project();
    const r = await rule(p, { trigger: { on: "item.created" }, actions: [{ kind: "addLabels", labels: ["policy"] }] }, { ownerId: bobId });
    // Bob may not edit what's assigned to Alice. A deny on an item attribute
    // fails closed at the project check (requireProjectRead gives it no item),
    // for a rule exactly as for Bob in the app: he edits nothing there.
    await prisma.orgMember.update({
      where: { orgId_userId: { orgId, userId: bobId } },
      data: { abacRules: [{ effect: "deny", actions: ["ITEM_UPDATE"], conditions: [{ attr: "assigneeId", op: "eq", value: aliceId }] }] },
    });
    try {
      const hers = await item(p, { assigneeId: aliceId });
      const free = await item(p);
      await settle();
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id: hers } })).tags).toEqual([]);
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id: free } })).tags).toEqual([]);
      expect((await runsOf(r.id)).map((x) => x.status)).toEqual(["FAILED", "FAILED"]);
    } finally {
      await prisma.orgMember.update({ where: { orgId_userId: { orgId, userId: bobId } }, data: { abacRules: [] } });
    }
  });

  it("switches itself off, and tells no one it can't, when its owner has left the org", async () => {
    const p = await project();
    const r = await rule(p, { trigger: { on: "item.created" }, actions: [{ kind: "addLabels", labels: ["x"] }] });
    await prisma.orgMember.delete({ where: { orgId_userId: { orgId, userId: aliceId } } });
    await item(p);
    await settle();
    expect((await runsOf(r.id)).map((x) => x.status)).toEqual(["FAILED"]);
    expect(await prisma.automationRule.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/owner/i) });
  });
});

describe("loop and rate guards", () => {
  const fake = (p: string, subjectId: string, over: Partial<RuleEvent> = {}): RuleEvent => ({
    id: BigInt(Math.floor(Math.random() * 1e12)),
    orgId, projectId: p, type: "work_item.created", subjectId, payload: {}, actorId: aliceId, source: "API",
    correlationId: crypto.randomUUID(), depth: 0, causedByRuleId: null, ...over,
  });

  it("calls a chain past the depth limit a LOOP, and switches the rule off after three in an hour", async () => {
    const p = await project();
    const id = await item(p);
    const r = await rule(p, { trigger: { on: "item.created" }, actions: [{ kind: "addLabels", labels: ["deep"] }] }, { allowChain: true });
    for (let i = 0; i < 3; i++) await runRulesForEvents([fake(p, id, { depth: 10, source: "AUTOMATION", causedByRuleId: crypto.randomUUID() })]);
    expect((await runsOf(r.id)).map((x) => x.status)).toEqual(["LOOP", "LOOP", "LOOP"]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).tags).toEqual([]);
    expect(await prisma.automationRule.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/looped/) });
  });

  it("throttles and switches off a rule that runs too often", async () => {
    const p = await project();
    const id = await item(p);
    const r = await rule(p, { trigger: { on: "item.created" }, actions: [{ kind: "addLabels", labels: ["busy"] }] });
    await prisma.automationRun.createMany({
      data: Array.from({ length: RULE_RUNS_PER_5_MIN }, () => ({ orgId, ruleId: r.id, ruleRevision: 1, correlationId: crypto.randomUUID(), depth: 1, status: "SUCCESS" as const, durationMs: 1 })),
    });
    await runRulesForEvents([fake(p, id)]);
    const last = (await runsOf(r.id)).at(-1)!;
    expect(last.status).toBe("THROTTLED");
    expect((await prisma.automationRule.findUniqueOrThrow({ where: { id: r.id } })).enabled).toBe(false);
  });
});

describe("scheduled rules", () => {
  it("acts on what its query finds, in its own project, once per slot", async () => {
    const p = await project();
    const other = await project();
    const mine = await item(p, { priority: "LOW" });
    const theirs = await item(other, { priority: "LOW" });
    const r = await rule(p, { trigger: { on: "schedule", every: "day", hour: 9, minute: 0, cql: "priority = LOW" }, actions: [{ kind: "addLabels", labels: ["swept"] }] });
    const at = (iso: string) => () => new Date(iso);
    expect(await runDueSchedules({ orgId, now: at("2026-10-24T09:05:00Z") })).toBe(1);
    expect(await runDueSchedules({ orgId, now: at("2026-10-24T12:00:00Z") })).toBe(0);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: mine } })).tags).toEqual(["swept"]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: theirs } })).tags).toEqual([]);
    expect((await runsOf(r.id)).map((x) => [x.status, x.eventId])).toEqual([["SUCCESS", null]]);
  });

  it("counts its item limit in its own project: another project's matches can't crowd its own out", async () => {
    const p = await project();
    const other = await project();
    const tail = () => Math.random().toString(16).slice(2, 14).padEnd(12, "0");
    // The other project's matches sort first by id and alone would fill the limit.
    const theirs = [await item(other, { priority: "LOW", id: `00000000-0000-4000-8000-${tail()}` }), await item(other, { priority: "LOW", id: `00000000-0000-4000-8000-${tail()}` })];
    const mine = await item(p, { priority: "LOW", id: `ffffffff-ffff-4fff-bfff-${tail()}` });
    const limits = AUTOMATION_LIMITS as { scheduledItems: number };
    const was = limits.scheduledItems;
    limits.scheduledItems = 2;
    try {
      const r = await rule(p, { trigger: { on: "schedule", every: "day", hour: 9, minute: 0, cql: "priority = LOW" }, actions: [{ kind: "addLabels", labels: ["swept"] }] });
      await runDueSchedules({ orgId, now: () => new Date("2026-10-25T09:05:00Z") });
      expect((await runsOf(r.id)).map((x) => x.status)).toEqual(["SUCCESS"]);
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id: mine } })).tags).toEqual(["swept"]);
      for (const id of theirs) expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).tags).toEqual([]);
    } finally {
      limits.scheduledItems = was;
    }
  });

  it("runs its query with its project as the context, as it was saved: currentProject() works", async () => {
    const p = await project();
    const other = await project();
    const mine = await item(p, { priority: "LOW" });
    await item(other, { priority: "LOW" });
    const r = await rule(p, {
      trigger: { on: "schedule", every: "day", hour: 9, minute: 0, cql: "project = currentProject() AND priority = LOW" },
      actions: [{ kind: "addLabels", labels: ["here"] }],
    });
    await runDueSchedules({ orgId, now: () => new Date("2026-10-26T09:05:00Z") });
    expect((await runsOf(r.id)).map((x) => x.status)).toEqual(["SUCCESS"]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: mine } })).tags).toEqual(["here"]);
  });
});

describe("a project rule's condition", () => {
  it("runs with its project as the context, as it was saved: currentProject() matches, not FAILED", async () => {
    const p = await project();
    const r = await rule(p, { trigger: { on: "item.created" }, condition: { cql: "project = currentProject()" }, actions: [{ kind: "addLabels", labels: ["ctx"] }] });
    const id = await item(p);
    await settle();
    expect((await runsOf(r.id)).map((x) => x.status)).toEqual(["SUCCESS"]);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).tags).toEqual(["ctx"]);
  });
});

describe("saving a rule", () => {
  it("warns, by name, when rules that allow chains can keep firing each other", async () => {
    const p = await project();
    const a = { trigger: { on: "item.updated", fields: ["priority"] }, actions: [{ kind: "transition", to: "doing" }] };
    const b = { trigger: { on: "item.transitioned", to: ["doing"] }, actions: [{ kind: "setField", field: "priority", value: "HIGH" }] };
    await rule(p, b, { name: "Bump priority", allowChain: true });
    expect(await ruleWarnings(orgId, p, { name: "Start it", spec: a, allowChain: true })).toEqual([
      expect.stringContaining("Start it → Bump priority → Start it"),
    ]);
    // Not if this one doesn't let changes fire it, nor if nothing it does fires the other.
    expect(await ruleWarnings(orgId, p, { name: "Start it", spec: a, allowChain: false })).toEqual([]);
    expect(await ruleWarnings(orgId, p, { name: "Comment", spec: { ...a, actions: [{ kind: "addComment", body: "x" }] }, allowChain: true })).toEqual([]);
  });


  it("refuses what the project or org doesn't have, with every issue", async () => {
    const p = await project();
    const ctx = await aliceCtx();
    await expect(
      createRule(ctx, {
        projectId: p,
        name: "bad",
        spec: {
          trigger: { on: "item.transitioned", to: ["ghost"] },
          condition: { cql: "nonsense ~~ 1" },
          actions: [
            { kind: "webhook", webhookId: crypto.randomUUID() },
            { kind: "addComment", body: "{{item.secret}}" },
            { kind: "transition", to: "done", cancel: { reason: "OBE" } },
            { kind: "transition", to: "cancelled", cancel: { reason: "OTHER" } },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "automation_invalid",
      extensions: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "trigger.to" }),
          expect.objectContaining({ path: "actions.0" }),
          expect.objectContaining({ path: "actions.1" }),
          expect.objectContaining({ path: "condition.cql" }),
          expect.objectContaining({ path: "actions.2.cancel", message: expect.stringMatching(/only for a move to a Cancelled/) }),
          expect.objectContaining({ path: "actions.3.cancel", message: expect.stringMatching(/note/) }),
        ]),
      },
    });
  });

  it("makes the saver the owner at their own access, and an edit hands it to the editor and turns it back on", async () => {
    const p = await project();
    const created = await createRule(await aliceCtx(), { projectId: p, name: "ok", spec: { trigger: { on: "item.created" }, actions: [{ kind: "archive" }] } });
    expect(created).toMatchObject({ ownerId: aliceId, revision: 1, enabled: true });
    expect(await prisma.automationRule.findUniqueOrThrow({ where: { id: created.id }, select: { actorCap: true } })).toEqual({
      actorCap: maskToDb((await aliceCtx()).permissions),
    });
    await prisma.automationRule.update({ where: { id: created.id }, data: { enabled: false, disabledReason: "Its owner is no longer a member." } });
    const bob = (await loadMemberAuthContext(orgId, bobId))!;
    const taken = await updateRule(bob, { id: created.id, projectId: p, revision: 1 }, { enabled: true });
    expect(taken).toMatchObject({ ownerId: bobId, revision: 2, enabled: true, disabledReason: null });
    expect(await prisma.automationRule.findUniqueOrThrow({ where: { id: created.id }, select: { actorCap: true } })).toEqual({ actorCap: maskToDb(bob.permissions) });
    // A save on a revision someone else already moved on from is refused.
    await expect(updateRule(bob, { id: created.id, projectId: p, revision: 1 }, { name: "stale" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("templates (§5.3)", () => {
  const pick = (cats: readonly string[]) => STATUSES.find((s) => cats.includes(s.category))!.key;
  const valuesFor = (t: AutomationTemplate) =>
    Object.fromEntries(t.params.map((p) => [p.key, p.kind === "status" ? pick(p.categories) : p.default]));

  it("each builds a rule the server saves for a project: its statuses exist and its query compiles", async () => {
    const p = await project();
    const ctx = await aliceCtx();
    for (const t of AUTOMATION_TEMPLATES) {
      const saved = await createRule(ctx, { projectId: p, name: t.name, spec: t.build(valuesFor(t)), templateKey: t.key });
      expect(saved.templateKey).toBe(t.key);
    }
    expect(await prisma.automationRule.count({ where: { projectId: p } })).toBe(AUTOMATION_TEMPLATES.length);
  });

  it("close stale: cancels, as overcome by events, open items untouched for the days given, and leaves recent ones", async () => {
    const p = await project();
    const t = templateByKey("close-stale")!;
    const saved = await createRule(await aliceCtx(), { projectId: p, name: t.name, spec: t.build({ ...valuesFor(t), days: 30 }) });
    const [old, fresh] = [await item(p), await item(p)];
    await prisma.$executeRaw`UPDATE work_items SET updated_at = now() - interval '40 days' WHERE id = ${old}::uuid`;
    const six = new Date();
    six.setUTCHours(6, 5, 0, 0);
    expect(await runDueSchedules({ orgId, now: () => six })).toBe(1);
    const fields = { columnKey: true, cancelReason: true } as const;
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: old }, select: fields })).toEqual({ columnKey: "cancelled", cancelReason: "OBE" });
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: fresh }, select: fields })).toEqual({ columnKey: "todo", cancelReason: null });
    expect((await prisma.comment.findFirstOrThrow({ where: { workItemId: old } })).content).toBe(`Cancelled by "${t.name}": no one had updated it for 30 days.`);
    expect((await runsOf(saved.id)).map((r) => r.status)).toEqual(["SUCCESS"]);
  });

  it("parent follows children: the parent is done when its last child is, and not before", async () => {
    const p = await project();
    const t = templateByKey("parent-done-with-children")!;
    await createRule(await aliceCtx(), { projectId: p, name: t.name, spec: t.build(valuesFor(t)) });
    const parent = await item(p);
    const [a, b] = [await item(p, { parentId: parent }), await item(p, { parentId: parent })];
    await settle();
    await move(p, a, "cancelled");
    await settle();
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: parent } })).columnKey).toBe("todo");
    await move(p, b, "done");
    await settle();
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: parent } })).columnKey).toBe("done");
  });
});
