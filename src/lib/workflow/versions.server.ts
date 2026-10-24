/**
 * Editing workflows: forking one, its draft, validating and diffing the draft,
 * publishing it, restoring an old version, assigning a workflow to a project
 * or type, and org templates.
 *
 * A workflow has at most one DRAFT version and at most one PUBLISHED one; a
 * publish supersedes the old version, and versions never change once
 * published (design §8.3). Items are never pinned to a version: a transition
 * always runs against the current published one. So a publish (or a new
 * assignment) that drops a status still holding items must say where those
 * items go; that map is stored on the version (or the assignment), and the
 * migration job (migrate.server.ts) moves them from it until none are left.
 */
import { createHash } from "node:crypto";
import { Prisma, type WorkflowEnforcement } from "@prisma/client";
import { NotFoundError } from "@/lib/rbac/check";
import { WorkflowEditError } from "@/lib/workflow/contract";
import { buildOpenDefinition } from "@/lib/workflow/compile";
import {
  validateDefinition,
  workflowDefinitionSchema,
  type ConditionNode,
  type DefinitionIssue,
  type FieldRef,
  type MigrationMap,
  type StatusRef,
  type ValidatorSpec,
  type VersionLayout,
  type WorkflowDefinition,
} from "@/lib/workflow/definition";

export type { MigrationMap, VersionLayout };
import { workflowSettings } from "@/lib/workflow/settings";
import { ensureStatuses, loadStatuses, type StatusRow } from "@/lib/workflow/statuses.server";
import { assignableMembersWhere } from "@/lib/work-items/apply-change.server";

type Tx = Prisma.TransactionClient;

/** sha256 of the definition with its keys sorted: which rules were in force. */
export function definitionChecksum(def: WorkflowDefinition): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
        : v;
  return createHash("sha256").update(JSON.stringify(canonical(def))).digest("hex");
}

const statusRefs = (rows: readonly StatusRow[]): (StatusRef & { name: string; sortOrder: number })[] =>
  rows.map((r) => ({ key: r.key, name: r.name, category: r.category, sortOrder: r.sortOrder, archived: r.archivedAt !== null }));

/** Parse a stored or submitted definition; a shape error is the editor's to fix. */
export function parseDefinition(raw: unknown): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowEditError("workflow_invalid", "The workflow's definition is malformed.", {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({
        severity: "error",
        code: "SCHEMA",
        message: `${i.path.join(".") || "definition"}: ${i.message}`,
      })),
    });
  }
  return parsed.data;
}

// ── Scope: which items a workflow governs ─────────────────────────────────

/**
 * The items an assignment row governs: a type's own row governs that type, the
 * project default governs every type without a row of its own.
 */
async function assignmentScope(
  tx: Tx,
  projectId: string,
  workItemTypeId: string | null,
): Promise<Prisma.WorkItemWhereInput> {
  if (workItemTypeId) return { projectId, workItemTypeId };
  const own = await tx.workflowAssignment.findMany({
    where: { projectId, workItemTypeId: { not: null } },
    select: { workItemTypeId: true },
  });
  const excluded = own.map((a) => a.workItemTypeId!);
  return excluded.length > 0 ? { projectId, workItemTypeId: { notIn: excluded } } : { projectId };
}

/** The items a workflow governs through all its assignments, or null when it governs none. */
async function workflowScope(tx: Tx, workflowId: string): Promise<Prisma.WorkItemWhereInput | null> {
  const rows = await tx.workflowAssignment.findMany({
    where: { workflowId },
    select: { projectId: true, workItemTypeId: true },
  });
  if (rows.length === 0) return null;
  const scopes = await Promise.all(rows.map((r) => assignmentScope(tx, r.projectId, r.workItemTypeId)));
  return scopes.length === 1 ? scopes[0] : { OR: scopes };
}

async function countByStatus(tx: Tx, where: Prisma.WorkItemWhereInput | null): Promise<Map<string, number>> {
  if (!where) return new Map();
  const rows = await tx.workItem.groupBy({ by: ["columnKey"], where, _count: { _all: true } });
  return new Map(rows.map((r) => [r.columnKey, r._count._all]));
}

// ── Reading ───────────────────────────────────────────────────────────────

const VERSION_SELECT = {
  id: true,
  version: true,
  state: true,
  definition: true,
  layout: true,
  checksum: true,
  migrationMap: true,
  publishedAt: true,
  publishedById: true,
  createdAt: true,
} as const;

/** A project's workflows, what each governs, and which types follow which. */
export async function listProjectWorkflows(tx: Tx, projectId: string) {
  const [workflows, assignments] = await Promise.all([
    tx.workflow.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        enforcement: true,
        createdAt: true,
        updatedAt: true,
        publishedVersion: { select: { version: true, publishedAt: true } },
        versions: { where: { state: "DRAFT" }, select: { version: true, createdAt: true } },
      },
    }),
    tx.workflowAssignment.findMany({
      where: { projectId },
      select: { workItemTypeId: true, workflowId: true, assignedAt: true },
    }),
  ]);
  return {
    workflows: workflows.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      enforcement: w.enforcement,
      published: w.publishedVersion,
      draft: w.versions[0] ?? null,
      assignedTo: assignments.filter((a) => a.workflowId === w.id).map((a) => a.workItemTypeId),
    })),
    assignments,
  };
}

/** One workflow with its versions; the draft and published definitions in full. */
export async function getWorkflow(tx: Tx, scope: { orgId: string; projectId: string | null }, workflowId: string) {
  const wf = await tx.workflow.findFirst({
    where: { id: workflowId, orgId: scope.orgId, projectId: scope.projectId },
    select: {
      id: true,
      name: true,
      description: true,
      enforcement: true,
      projectId: true,
      publishedVersionId: true,
      createdAt: true,
      updatedAt: true,
      versions: { orderBy: { version: "desc" }, select: VERSION_SELECT },
      assignments: { select: { workItemTypeId: true } },
    },
  });
  if (!wf) throw new NotFoundError("Workflow not found");
  const draft = wf.versions.find((v) => v.state === "DRAFT") ?? null;
  const published = wf.versions.find((v) => v.id === wf.publishedVersionId) ?? null;
  return {
    id: wf.id,
    name: wf.name,
    description: wf.description,
    enforcement: wf.enforcement,
    assignedTo: wf.assignments.map((a) => a.workItemTypeId),
    draft,
    published,
    versions: wf.versions.map((v) => ({
      id: v.id,
      version: v.version,
      state: v.state,
      publishedAt: v.publishedAt,
      publishedById: v.publishedById,
      createdAt: v.createdAt,
    })),
  };
}

// ── Creating ──────────────────────────────────────────────────────────────

export type WorkflowSource =
  | { kind: "open" }
  | { kind: "copy"; workflowId: string }
  | { kind: "template"; templateId: string };

/**
 * A new CUSTOM workflow in a project, with a DRAFT v1. It starts from the open
 * workflow (today's behaviour: every status, a move into each from anywhere),
 * a copy of another of the project's workflows, or an org template, whose
 * statuses are created in the project when it doesn't have them. It governs
 * nothing until it is published and assigned.
 */
export async function createWorkflow(
  tx: Tx,
  args: { orgId: string; projectId: string; actorId: string; name: string; description?: string; from: WorkflowSource },
) {
  const taken = await tx.workflow.findFirst({ where: { projectId: args.projectId, name: args.name }, select: { id: true } });
  if (taken) throw new WorkflowEditError("workflow_in_use", "This project already has a workflow with that name.");

  let definition: WorkflowDefinition;
  let layout: VersionLayout = {};
  if (args.from.kind === "open") {
    const [statuses, org] = await Promise.all([
      loadStatuses(tx, args.projectId),
      tx.organization.findUnique({ where: { id: args.orgId }, select: { settings: true } }),
    ]);
    definition = buildOpenDefinition(statusRefs(statuses));
    // The open workflow's checks, written out so the editor shows them.
    const s = workflowSettings(org?.settings);
    const category = new Map(statuses.map((r) => [r.key, r.category]));
    definition = {
      ...definition,
      transitions: definition.transitions.map((t) => {
        const to = category.get(t.to);
        const validate: ValidatorSpec[] = [
          { kind: "wipLimit", scope: "board", hard: true },
          ...(to === "CANCELLED" ? [{ kind: "cancelReason" as const }] : []),
          ...(to === "DONE" && s.blockParentWithOpenChildren ? [{ kind: "childrenSettled" as const }] : []),
        ];
        return { ...t, id: t.to, validate };
      }),
    };
  } else {
    const sourceScope = args.from.kind === "copy" ? { projectId: args.projectId } : { projectId: null };
    const sourceId = args.from.kind === "copy" ? args.from.workflowId : args.from.templateId;
    const source = await tx.workflow.findFirst({
      where: { id: sourceId, orgId: args.orgId, ...sourceScope },
      select: { publishedVersion: { select: { definition: true, layout: true } }, versions: { where: { state: "DRAFT" }, select: { definition: true, layout: true } } },
    });
    const version = source?.publishedVersion ?? source?.versions[0];
    if (!version) throw new NotFoundError(args.from.kind === "copy" ? "Workflow not found" : "Template not found");
    definition = parseDefinition(version.definition);
    layout = (version.layout ?? {}) as VersionLayout;
    if (args.from.kind === "template") {
      // Copy-on-use: the template's statuses become the project's, if it lacks them.
      const catalog = layout.statusCatalog ?? [];
      await ensureStatuses(
        tx,
        { orgId: args.orgId, projectId: args.projectId },
        catalog.map((c) => ({ key: c.key, name: c.name, color: c.color, category: c.category, restore: true })),
      );
      layout = { nodes: layout.nodes };
    }
  }

  const wf = await uniqueName("workflow", () => tx.workflow.create({
    data: {
      orgId: args.orgId,
      projectId: args.projectId,
      name: args.name,
      description: args.description ?? "",
      createdById: args.actorId,
    },
    select: { id: true },
  }));
  await tx.workflowVersion.create({
    data: {
      orgId: args.orgId,
      workflowId: wf.id,
      version: 1,
      state: "DRAFT",
      definition,
      layout: layout as Prisma.InputJsonValue,
      checksum: definitionChecksum(definition),
    },
  });
  return wf.id;
}

/**
 * A name another workflow (or, for a template, another template) already
 * has: the unique indexes decide, so two saves at once can't both take it.
 */
/** A write that lost a race to another change's unique row or deleted key: a 409 to retry, not a 500. */
async function raced<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2002" || e.code === "P2003")) {
      throw new WorkflowEditError("workflow_in_use", "Someone changed this workflow's assignments at the same time. Reload and try again.");
    }
    throw e;
  }
}

async function uniqueName<T>(what: "workflow" | "template", write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new WorkflowEditError("workflow_in_use", what === "template" ? "There is already a template with that name." : "Another workflow already has that name.");
    }
    throw e;
  }
}

/** Name, description and enforcement (SHADOW records refusals without blocking). */
export async function updateWorkflowMeta(
  tx: Tx,
  scope: { orgId: string; projectId: string | null },
  workflowId: string,
  data: { name?: string; description?: string; enforcement?: WorkflowEnforcement },
) {
  const wf = await tx.workflow.findFirst({ where: { id: workflowId, ...scope }, select: { id: true, projectId: true } });
  if (!wf) throw new NotFoundError("Workflow not found");
  if (data.name) {
    const taken = await tx.workflow.findFirst({
      where: { projectId: wf.projectId, name: data.name, id: { not: workflowId } },
      select: { id: true },
    });
    if (taken) throw new WorkflowEditError("workflow_in_use", "Another workflow already has that name.");
  }
  await uniqueName("workflow", () => tx.workflow.update({ where: { id: workflowId }, data }));
}

/** Delete a workflow nothing is assigned to. */
export async function deleteWorkflow(tx: Tx, scope: { orgId: string; projectId: string | null }, workflowId: string) {
  const wf = await tx.workflow.findFirst({
    where: { id: workflowId, ...scope },
    select: { id: true, _count: { select: { assignments: true } } },
  });
  if (!wf) throw new NotFoundError("Workflow not found");
  if (wf._count.assignments > 0) {
    throw new WorkflowEditError("workflow_in_use", "Assign another workflow to the types using this one first.");
  }
  // An assignment made since the count above holds the row (ON DELETE RESTRICT).
  await raced(() => tx.workflow.delete({ where: { id: workflowId } }));
}

// ── The draft ─────────────────────────────────────────────────────────────

async function statusesForValidation(tx: Tx, projectId: string | null, layout: VersionLayout) {
  if (projectId) return statusRefs(await loadStatuses(tx, projectId, { includeArchived: true }));
  // A template validates against the statuses it carries.
  return (layout.statusCatalog ?? []).map((c, i) => ({ key: c.key, name: c.name, category: c.category, sortOrder: i }));
}

/**
 * Save the draft (autosave): the definition must be well-formed, and may still
 * have errors that stop a publish; those come back as `issues`. Creates the
 * draft, as the next version, when the workflow has none.
 */
/**
 * Take the workflow's row for the rest of the transaction: saving, discarding,
 * restoring and publishing a draft go one at a time, so an autosave can never
 * land on a version a publish just made immutable, and two publishes can't
 * both supersede the same version.
 */
async function lockWorkflow(tx: Tx, workflowId: string) {
  await tx.$queryRaw`SELECT id FROM workflows WHERE id = ${workflowId}::uuid FOR UPDATE`;
}

export async function saveDraft(
  tx: Tx,
  scope: { orgId: string; projectId: string | null },
  workflowId: string,
  body: { definition: unknown; layout?: VersionLayout },
): Promise<{ version: number; issues: DefinitionIssue[] }> {
  await lockWorkflow(tx, workflowId);
  const wf = await tx.workflow.findFirst({
    where: { id: workflowId, ...scope },
    select: { id: true, projectId: true, versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, state: true, id: true, layout: true } } },
  });
  if (!wf) throw new NotFoundError("Workflow not found");
  const definition = parseDefinition(body.definition);
  const latest = wf.versions[0];
  const layout = (body.layout ?? (latest?.layout as VersionLayout | undefined) ?? {}) as VersionLayout;
  const data = { definition, layout: layout as Prisma.InputJsonValue, checksum: definitionChecksum(definition) };
  let version: number;
  // Only ever a draft: a version that stopped being one is never written again.
  const updated = latest?.state === "DRAFT"
    ? (await tx.workflowVersion.updateMany({ where: { id: latest.id, state: "DRAFT" }, data })).count
    : 0;
  if (updated > 0) {
    version = latest!.version;
  } else {
    version = (latest?.version ?? 0) + 1;
    await tx.workflowVersion.create({ data: { orgId: scope.orgId, workflowId, version, state: "DRAFT", ...data } });
  }
  await tx.workflow.update({ where: { id: workflowId }, data: { updatedAt: new Date() } });
  return { version, issues: validateDefinition(definition, await statusesForValidation(tx, wf.projectId, layout)) };
}

export async function discardDraft(tx: Tx, scope: { orgId: string; projectId: string | null }, workflowId: string) {
  await lockWorkflow(tx, workflowId);
  const wf = await tx.workflow.findFirst({ where: { id: workflowId, ...scope }, select: { id: true } });
  if (!wf) throw new NotFoundError("Workflow not found");
  await tx.workflowVersion.deleteMany({ where: { workflowId, state: "DRAFT" } });
}

/** "Restore version N": a draft with N's definition, published like any other. */
export async function restoreVersion(tx: Tx, scope: { orgId: string; projectId: string | null }, workflowId: string, version: number) {
  await lockWorkflow(tx, workflowId);
  const old = await tx.workflowVersion.findFirst({
    where: { workflowId, version, workflow: scope },
    select: { definition: true, layout: true, state: true },
  });
  if (!old || old.state === "DRAFT") throw new NotFoundError("Version not found");
  return saveDraft(tx, scope, workflowId, { definition: old.definition, layout: old.layout as VersionLayout });
}

// ── Diff and publish ──────────────────────────────────────────────────────

export interface WorkflowDiff {
  addedStatuses: string[];
  /** Statuses the draft drops, with how many items the workflow governs in each. */
  removedStatuses: { key: string; items: number }[];
  addedTransitions: { id: string; name: string }[];
  removedTransitions: { id: string; name: string }[];
  changedTransitions: { id: string; name: string }[];
}

/** What a draft changes against the published version (or against nothing, for a first publish). */
export function diffDefinitions(
  before: WorkflowDefinition | null,
  after: WorkflowDefinition,
  itemsByStatus: ReadonlyMap<string, number>,
  /** For a first publish: the statuses the items it will govern are in now. */
  currentStatuses: readonly string[] = [],
): WorkflowDiff {
  const beforeKeys = before ? before.statuses.map((s) => s.key) : [...currentStatuses];
  const afterKeys = new Set(after.statuses.map((s) => s.key));
  const beforeSet = new Set(beforeKeys);
  const beforeT = new Map((before?.transitions ?? []).map((t) => [t.id, t]));
  const afterT = new Map(after.transitions.map((t) => [t.id, t]));
  return {
    addedStatuses: [...afterKeys].filter((k) => !beforeSet.has(k)),
    removedStatuses: beforeKeys
      .filter((k) => !afterKeys.has(k))
      .map((key) => ({ key, items: itemsByStatus.get(key) ?? 0 })),
    addedTransitions: [...afterT.values()].filter((t) => !beforeT.has(t.id)).map((t) => ({ id: t.id, name: t.name })),
    removedTransitions: [...beforeT.values()].filter((t) => !afterT.has(t.id)).map((t) => ({ id: t.id, name: t.name })),
    changedTransitions: [...afterT.values()]
      .filter((t) => beforeT.has(t.id) && JSON.stringify(beforeT.get(t.id)) !== JSON.stringify(t))
      .map((t) => ({ id: t.id, name: t.name })),
  };
}

/** The draft's issues and its diff against the published version: what a publish would do. */
export async function previewPublish(tx: Tx, scope: { orgId: string; projectId: string | null }, workflowId: string) {
  const wf = await tx.workflow.findFirst({
    where: { id: workflowId, ...scope },
    select: {
      id: true,
      projectId: true,
      publishedVersion: { select: { definition: true } },
      versions: { where: { state: "DRAFT" }, select: { id: true, version: true, definition: true, layout: true } },
    },
  });
  if (!wf) throw new NotFoundError("Workflow not found");
  const draft = wf.versions[0];
  if (!draft) throw new NotFoundError("This workflow has no draft to publish.");
  const definition = parseDefinition(draft.definition);
  const issues = [
    ...validateDefinition(definition, await statusesForValidation(tx, wf.projectId, draft.layout as VersionLayout)),
    ...(await referenceIssues(tx, scope.orgId, wf.projectId, definition)),
  ];
  const before = wf.publishedVersion ? parseDefinition(wf.publishedVersion.definition) : null;
  const counts = await countByStatus(tx, await workflowScope(tx, workflowId));
  return { wf, draft, definition, issues, diff: diffDefinitions(before, definition, counts) };
}

/**
 * The people, teams and intervals a definition's actions name: an assignee
 * must be in the org, and a team or interval must belong to the project. The
 * engine checks what a transition writes as well (checkTransitionPatch); this
 * says so at publish, where it can be fixed, rather than on someone's move.
 * A template has no project, so only its assignees are checked.
 */
async function referenceIssues(tx: Tx, orgId: string, projectId: string | null, def: WorkflowDefinition): Promise<DefinitionIssue[]> {
  const users = new Map<string, string>();
  const teams = new Map<string, string>();
  const intervals = new Map<string, string>();
  const conditionTeams = new Map<string, string>();
  const customKeys = new Map<string, string>();
  const custom = (f: FieldRef, name: string) => {
    if ("custom" in f) customKeys.set(f.custom, name);
  };
  const walk = (n: ConditionNode, name: string): void => {
    if ("all" in n) return n.all.forEach((c) => walk(c, name));
    if ("any" in n) return n.any.forEach((c) => walk(c, name));
    if ("not" in n) return walk(n.not, name);
    if (n.kind === "actorInTeam" && n.teamId !== "item") conditionTeams.set(n.teamId, name);
    if (n.kind === "field") custom(n.field, name);
  };
  for (const s of def.statuses) for (const r of s.fieldRules ?? []) custom(r.field, `The "${s.key}" status`);
  for (const t of def.transitions) {
    if (t.restrict) walk(t.restrict, t.name);
    for (const i of t.input ?? []) custom(i.field, t.name);
    for (const v of t.validate ?? []) {
      if (v.kind === "fieldsRequired") v.fields.forEach((f) => custom(f, t.name));
      if (v.kind === "field") custom(v.field, t.name);
    }
    for (const a of t.actions ?? []) {
      if (a.kind === "setField" || a.kind === "clearField") custom(a.field, t.name);
      if (a.kind === "assign" && typeof a.to === "object") users.set(a.to.userId, t.name);
      if (a.kind === "setField" && "system" in a.field && "literal" in a.value && typeof a.value.literal === "string") {
        const into = a.field.system === "assigneeId" ? users : a.field.system === "teamId" ? teams : a.field.system === "intervalId" ? intervals : null;
        into?.set(a.value.literal, t.name);
      }
    }
  }
  const issues: DefinitionIssue[] = [];
  const missing = async (refs: Map<string, string>, found: (ids: string[]) => Promise<{ id: string }[]>, code: string, what: string) => {
    if (refs.size === 0) return;
    const have = new Set((await found([...refs.keys()])).map((r) => r.id));
    for (const [id, name] of refs) if (!have.has(id)) issues.push({ severity: "error", code, message: `"${name}" ${what}` });
  };
  await missing(
    users,
    // The same members a change may assign (apply-change.server.ts): current and active.
    async (ids) => (await tx.orgMember.findMany({ where: assignableMembersWhere(orgId, ids), select: { userId: true } })).map((m) => ({ id: m.userId })),
    "UNKNOWN_ASSIGNEE",
    "assigns someone who isn't a member of this organization.",
  );
  await missing(
    customKeys,
    async (keys) => (await tx.customField.findMany({ where: { orgId, key: { in: keys } }, select: { key: true } })).map((f) => ({ id: f.key })),
    "UNKNOWN_FIELD",
    "uses a custom field this organization doesn't have.",
  );
  if (projectId) {
    await missing(teams, (ids) => tx.team.findMany({ where: { id: { in: ids }, projectId }, select: { id: true } }), "UNKNOWN_TEAM", "sets a team that isn't part of this project.");
    // A restriction naming a team that isn't here would refuse everyone, for good.
    await missing(conditionTeams, (ids) => tx.team.findMany({ where: { id: { in: ids }, projectId }, select: { id: true } }), "UNKNOWN_TEAM", "is restricted to a team that isn't part of this project.");
    await missing(intervals, (ids) => tx.interval.findMany({ where: { id: { in: ids }, projectId }, select: { id: true } }), "UNKNOWN_INTERVAL", "sets an interval that isn't part of this project.");
  }
  return issues;
}

/** A migration map must send every listed key to a status in `def`; extra keys are dropped. */
function checkMap(
  needed: readonly { key: string; items: number }[],
  map: MigrationMap,
  def: WorkflowDefinition,
): MigrationMap {
  const into = new Set(def.statuses.map((s) => s.key));
  const missing = needed.filter((n) => n.items > 0 && !into.has(map[n.key] ?? ""));
  if (missing.length > 0) {
    throw new WorkflowEditError(
      "migration_map_required",
      `${missing.length === 1 ? "A status that still holds items isn't" : "Statuses that still hold items aren't"} in the new workflow: say where their items go.`,
      { statuses: missing, options: [...into] },
    );
  }
  return Object.fromEntries(needed.filter((n) => n.items > 0).map((n) => [n.key, map[n.key]]));
}

/**
 * Publish the draft: it becomes the PUBLISHED version, the old one is
 * SUPERSEDED, and every transition from now on runs against it. A draft with
 * errors is refused; so is one that drops occupied statuses without a map for
 * them. Items are moved afterwards, by the migration job, from the stored map.
 */
export async function publishDraft(
  tx: Tx,
  scope: { orgId: string; projectId: string | null },
  workflowId: string,
  args: { actorId: string; migrationMap?: MigrationMap },
) {
  await lockWorkflow(tx, workflowId);
  const { draft, definition, issues, diff } = await previewPublish(tx, scope, workflowId);
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw new WorkflowEditError("workflow_invalid", "Fix the workflow's errors before publishing it.", { issues: errors });
  }
  // The previous publish's map still applies to items the job hasn't moved
  // yet, for statuses this version doesn't bring back: carry it forward (the
  // job follows a chain of maps to a status the workflow uses).
  const into = new Set(definition.statuses.map((st) => st.key));
  const previous = Object.fromEntries(
    Object.entries(((await tx.workflowVersion.findFirst({ where: { workflowId, state: "PUBLISHED" }, select: { migrationMap: true } }))?.migrationMap ?? {}) as MigrationMap)
      .filter(([from]) => !into.has(from)),
  );
  const migrationMap = { ...previous, ...checkMap(diff.removedStatuses, args.migrationMap ?? {}, definition) };
  const now = new Date();
  await tx.workflowVersion.updateMany({ where: { workflowId, state: "PUBLISHED" }, data: { state: "SUPERSEDED" } });
  await tx.workflowVersion.update({
    where: { id: draft.id },
    data: {
      state: "PUBLISHED",
      checksum: definitionChecksum(definition),
      publishedAt: now,
      publishedById: args.actorId,
      ...(Object.keys(migrationMap).length > 0 && { migrationMap }),
    },
  });
  await tx.workflow.update({ where: { id: workflowId }, data: { publishedVersionId: draft.id, updatedAt: now } });
  return { version: draft.version, diff, migrationMap };
}

// ── Assignment ────────────────────────────────────────────────────────────

/**
 * Which workflow governs a type (or, with no type, the project default). Null
 * returns it to the open workflow, or for a type to the project default. Items
 * whose status the newly governing workflow doesn't use need a map, kept on
 * the assignment for the migration job.
 */
export async function assignWorkflow(
  tx: Tx,
  args: { orgId: string; projectId: string; workItemTypeId: string | null; workflowId: string | null; migrationMap?: MigrationMap },
) {
  const where = { projectId: args.projectId, workItemTypeId: args.workItemTypeId };
  const scope = await assignmentScope(tx, args.projectId, args.workItemTypeId);
  const counts = await countByStatus(tx, scope);

  // The statuses of whatever governs the scope afterwards.
  let target: { definition: WorkflowDefinition } | null = null;
  if (args.workflowId) {
    const wf = await tx.workflow.findFirst({
      where: { id: args.workflowId, projectId: args.projectId },
      select: { publishedVersion: { select: { definition: true } } },
    });
    if (!wf) throw new NotFoundError("Workflow not found");
    if (!wf.publishedVersion) throw new WorkflowEditError("workflow_invalid", "Publish the workflow before assigning it.");
    target = { definition: parseDefinition(wf.publishedVersion.definition) };
  } else if (args.workItemTypeId) {
    // Back to the project default.
    const fallback = await tx.workflowAssignment.findFirst({
      where: { projectId: args.projectId, workItemTypeId: null },
      select: { workflow: { select: { publishedVersion: { select: { definition: true } } } } },
    });
    const def = fallback?.workflow.publishedVersion?.definition;
    if (def) {
      const definition = parseDefinition(def);
      const into = new Set(definition.statuses.map((s) => s.key));
      const stranded = [...counts].filter(([k, n]) => n > 0 && !into.has(k));
      if (stranded.length > 0) {
        // The default row's own map is for its own change; ask for this one explicitly.
        throw new WorkflowEditError(
          "migration_map_required",
          "The project's default workflow doesn't use some of this type's statuses. Assign the default workflow to this type explicitly to map them.",
          { statuses: stranded.map(([key, items]) => ({ key, items })), options: [...into] },
        );
      }
    }
  }

  if (!args.workflowId) {
    await tx.workflowAssignment.deleteMany({ where });
    return { migrationMap: {} };
  }
  const into = new Set(target!.definition.statuses.map((s) => s.key));
  const needed = [...counts].filter(([k]) => !into.has(k)).map(([key, items]) => ({ key, items }));
  const migrationMap = checkMap(needed, args.migrationMap ?? {}, target!.definition);
  const data = {
    workflowId: args.workflowId,
    migrationMap: Object.keys(migrationMap).length > 0 ? migrationMap : undefined,
    assignedAt: new Date(),
  };
  const existing = await tx.workflowAssignment.findFirst({ where, select: { id: true } });
  // Another assignment of the same type made since the read above, or the
  // workflow deleted since: the indexes and keys decide, and the loser is told.
  await raced(() =>
    existing
      ? tx.workflowAssignment.update({
          where: { id: existing.id },
          data: { ...data, migrationMap: data.migrationMap ?? ({} as Prisma.InputJsonValue) },
        })
      : tx.workflowAssignment.create({ data: { orgId: args.orgId, ...where, ...data } }),
  );
  return { migrationMap };
}

// ── Org templates ─────────────────────────────────────────────────────────

/** Org templates: workflows with no project, published, that projects copy (never share live). */
export async function listTemplates(tx: Tx, orgId: string) {
  return tx.workflow.findMany({
    where: { orgId, projectId: null, publishedVersionId: { not: null } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, description: true, updatedAt: true },
  });
}

/**
 * Save a project's workflow as an org template: its published definition, with
 * the statuses it uses (name, colour, category) so another project can take it.
 */
export async function createTemplateFrom(
  tx: Tx,
  args: { orgId: string; workflowId: string; name: string; description?: string; actorId: string },
) {
  const wf = await tx.workflow.findFirst({
    where: { id: args.workflowId, orgId: args.orgId, projectId: { not: null } },
    select: { projectId: true, publishedVersion: { select: { definition: true, layout: true } } },
  });
  if (!wf?.publishedVersion) throw new NotFoundError("Publish the workflow before saving it as a template.");
  const taken = await tx.workflow.findFirst({ where: { orgId: args.orgId, projectId: null, name: args.name }, select: { id: true } });
  if (taken) throw new WorkflowEditError("workflow_in_use", "There is already a template with that name.");
  const definition = parseDefinition(wf.publishedVersion.definition);
  const keys = new Set(definition.statuses.map((s) => s.key));
  const statuses = (await loadStatuses(tx, wf.projectId!, { includeArchived: true })).filter((s) => keys.has(s.key));
  const layout: VersionLayout = {
    nodes: (wf.publishedVersion.layout as VersionLayout | null)?.nodes,
    statusCatalog: statuses.map((s) => ({ key: s.key, name: s.name, color: s.color, category: s.category })),
  };
  const template = await uniqueName("template", () => tx.workflow.create({
    data: { orgId: args.orgId, projectId: null, name: args.name, description: args.description ?? "", createdById: args.actorId },
    select: { id: true },
  }));
  const version = await tx.workflowVersion.create({
    data: {
      orgId: args.orgId,
      workflowId: template.id,
      version: 1,
      state: "PUBLISHED",
      definition,
      layout: layout as Prisma.InputJsonValue,
      checksum: definitionChecksum(definition),
      publishedAt: new Date(),
      publishedById: args.actorId,
    },
    select: { id: true },
  });
  await tx.workflow.update({ where: { id: template.id }, data: { publishedVersionId: version.id } });
  return template.id;
}
