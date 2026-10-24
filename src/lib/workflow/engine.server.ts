/**
 * The workflow engine: whether a change to a work item may go through, and
 * what it becomes when it does.
 *
 * `applyWorkItemChange` calls `gateChange` before it writes anything. For each
 * item it finds the workflow that governs (project x type), and when the change
 * moves the item between statuses it resolves the transition, checks who may
 * take it (Restrict), folds in what the transition asked for (Request input),
 * runs its checks against the item as it would be (Validate) and adds what the
 * transition does (Perform). A change that does not move the item still has to
 * respect the current status's field rules.
 *
 * A project or type with no workflow assigned runs the OPEN workflow, generated
 * from its statuses: any status to any status, the optional cancel reason, and,
 * unless the org turned it off, the parent guard. A board's hard WIP limits
 * hold for every move into its columns, whatever surface it comes from. So a project nobody has
 * configured behaves as the board always did, now on every path.
 *
 * Refusals are `TransitionError`s (one item) or per-item denials (bulk). A
 * workflow in SHADOW mode computes them and lets the change through.
 */
import type { ColumnCategory, Prisma, WorkItem } from "@prisma/client";
import { NotFoundError, type AuthContext } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import type { WorkItemPatch } from "@/lib/work-items/apply-change.server";
import { boardShowsStatuses, loadStatuses } from "@/lib/workflow/statuses.server";
import { buildOpenDefinition, compiledVersion, compileWorkflow, openTransitionId, resolveTransition, type CompiledWorkflow } from "@/lib/workflow/compile";
import { restrictionAllows, restrictionMayAllow, type ConditionActor, type ConditionContext, type ConditionHistory, type ConditionItem } from "@/lib/workflow/conditions";
import { runValidators, type ValidationFacts } from "@/lib/workflow/validators";
import { applyActions, applyInput } from "@/lib/workflow/actions";
import { TransitionError, type AvailableTransition, type TransitionErrorBody, type TransitionInputField } from "@/lib/workflow/contract";
import { workflowDefinitionSchema, type ConditionNode, type FieldRef, type TransitionSpec, type ValidatorSpec, type WorkflowDefinition } from "@/lib/workflow/definition";
import { workflowSettings, type WorkflowSettings } from "@/lib/workflow/settings";
import { CANCEL_REASONS } from "@/lib/work-items/cancel";

type Tx = Prisma.TransactionClient;

/**
 * Where a change comes from decides how much of the workflow applies (design §4.4).
 *
 * - `full`: a person's change. Restrictions, requested input, checks, actions.
 * - `system`: a change with no person behind it (the system's own steps, a
 *   composed plugin's call without an actor). There is no one to restrict or
 *   ask, so restrictions and requested input are skipped and hidden
 *   transitions are open; the checks still run, so the parent guard and hard
 *   WIP limits hold on every path (owner decision).
 * - `structural`: the transition must exist, nothing more (import).
 * - `none`: no check at all. Only a workflow migration uses it: it moves items
 *   out of statuses the workflow no longer has, so no transition can apply.
 */
export type EnforcementLevel = "full" | "system" | "structural" | "none";

export interface TransitionRequest {
  /** Name the transition; otherwise the one between the two statuses is used. */
  id?: string;
  /** Values for the fields the transition asks for, keyed `system:x` / `custom:key`. */
  input?: Record<string, unknown>;
  /** Past restrictions and checks: needs WORKFLOW_OVERRIDE, audited. */
  force?: boolean;
}

/** A governing workflow, resolved for one (project, type). */
export interface GoverningWorkflow {
  compiled: CompiledWorkflow;
  /** Null for the open workflow. */
  workflowId: string | null;
  versionId: string | null;
  shadow: boolean;
  categories: ReadonlyMap<string, ColumnCategory>;
}

export interface ItemGate {
  itemId: string;
  /** The patch this item is written with: input and actions folded in. */
  patch: WorkItemPatch;
  /** A named transition taken (not the open workflow's global ones), for history. */
  transitionId: string | null;
  comments: string[];
  watchers: string[];
}

export interface Denial {
  itemId: string;
  status: number;
  body: TransitionErrorBody;
}

export interface GateResult {
  gates: ItemGate[];
  denials: Denial[];
  /** Refusals a SHADOW workflow computed and did not enforce. */
  shadow: Denial[];
  /** Refusals an override went past. */
  forced: Denial[];
}

const deny = (itemId: string, body: TransitionErrorBody): Denial => {
  const e = new TransitionError(body);
  return { itemId, status: e.status, body };
};

/** Every condition node in a tree, flattened. */
function nodes(node: ConditionNode | undefined): ConditionNode[] {
  if (!node) return [];
  if ("all" in node) return [node, ...node.all.flatMap(nodes)];
  if ("any" in node) return [node, ...node.any.flatMap(nodes)];
  if ("not" in node) return [node, ...nodes(node.not)];
  return [node];
}

/**
 * pg_advisory_xact_lock namespace for moves into a hard-WIP column (see
 * allocate.ts for the others). The two-int form, (namespace, hashtext(project:column)):
 * a collision of the 32-bit hash only makes two columns take turns needlessly.
 * The same column always hashes the same, so it can never under-lock.
 */
const WIP_LOCK_NAMESPACE = 20204;

type HardBoard = { id: string; name: string; teamId: string | null; columnName: string; limit: number };

/**
 * A change's view of the hard WIP limits: which boards hold each column to one,
 * and how many items this change has already let into each. A bulk change
 * gates every item before it writes any, so the database alone would let a
 * batch of ten through a column with one free place.
 */
function wipLedger(tx: Tx, projectId: string) {
  const byColumn = new Map<string, Promise<HardBoard[]>>();
  const admitted = new Map<string, number>();
  const boardsFor = (column: string) => {
    let hit = byColumn.get(column);
    if (!hit) {
      hit = tx.board
        .findMany({
          where: { projectId, config: { path: ["wipHardEnforce"], equals: true }, columns: { some: { key: column, wipLimit: { not: null } } } },
          select: { id: true, name: true, type: true, teamId: true, columns: { where: { key: column }, select: { name: true, wipLimit: true } } },
        })
        .then((rows) =>
          rows
            .filter((b) => boardShowsStatuses(b.type))
            .map((b) => ({ id: b.id, name: b.name, teamId: b.teamId, columnName: b.columns[0].name, limit: b.columns[0].wipLimit! })),
        );
      byColumn.set(column, hit);
    }
    return hit;
  };
  // A team board counts its team's items, so it holds only for an item of its team.
  const holding = async (column: string, teamId: string | null) =>
    (await boardsFor(column)).filter((b) => b.teamId === null || b.teamId === teamId);
  return {
    boardsFor,
    /** The first board this item would overflow, or the last one checked (all have room). */
    async check(item: WorkItem, column: string, teamId: string | null): Promise<ValidationFacts["wip"]> {
      let fact: ValidationFacts["wip"];
      for (const board of await holding(column, teamId)) {
        // Archived items are off every board. The item itself, if already there, is not counted twice.
        const inColumn = await tx.workItem.count({
          where: { projectId, columnKey: column, archivedAt: null, id: { not: item.id }, ...(board.teamId ? { teamId: board.teamId } : {}) },
        });
        fact = { limit: board.limit, countAfter: inColumn + (admitted.get(board.id) ?? 0) + 1, columnName: board.columnName, boardName: board.name };
        if (fact.countAfter > board.limit) break;
      }
      return fact;
    },
    /** An item this change lets into `column` (with `teamId`) takes a place on each board holding it. */
    async admit(item: WorkItem, column: string, teamId: string | null) {
      if (item.columnKey === column && item.teamId === teamId) return;
      for (const board of await holding(column, teamId)) admitted.set(board.id, (admitted.get(board.id) ?? 0) + 1);
    },
  };
}
type WipLedger = ReturnType<typeof wipLedger>;

/**
 * Lock what a change's checks read, before any of them run, in one fixed order
 * so concurrent changes can't deadlock: first the advisory lock of every column
 * an item enters or changes team in, where a board holds that column to a hard
 * limit, in sorted order; then every changed item and every moved item's
 * parent as rows, in id order, in one statement. The open-children check reads
 * a parent's children while the parent is held, and a sub-item's move holds its
 * parent, so a concurrent reopen is either seen or waits for the parent's move.
 */
async function lockMoves(tx: Tx, projectId: string, patch: WorkItemPatch, items: readonly WorkItem[], wip: WipLedger) {
  const to = patch.columnKey ?? undefined;
  const changed = items.filter((i) => (to !== undefined && i.columnKey !== to) || (patch.teamId !== undefined && i.teamId !== patch.teamId));
  if (changed.length === 0) return;
  const columns: string[] = [];
  for (const column of new Set(changed.map((i) => to ?? i.columnKey))) {
    if ((await wip.boardsFor(column)).length > 0) columns.push(column);
  }
  await lockInOrder(tx, projectId, columns, changed.flatMap((i) => (to !== undefined && i.parentId ? [i.id, i.parentId] : [i.id])));
}

/**
 * The one lock order every work-item change follows (see lockMoves): the
 * advisory locks of the hard-WIP `columns`, sorted, then the `rowIds`, sorted,
 * in one statement. A writer that touches items before its own change runs
 * (a merge fills the survivor before cancelling the duplicate) takes them all
 * here first, so its later locks are ones it already holds.
 */
export async function lockInOrder(tx: Tx, projectId: string, columns: readonly string[], rowIds: readonly string[]) {
  for (const column of [...new Set(columns)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WIP_LOCK_NAMESPACE}::int, hashtext(${`${projectId}:${column}`}))`;
  }
  const ids = [...new Set(rowIds)].sort();
  if (ids.length > 0) await tx.$queryRaw`SELECT id FROM work_items WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
}

/** The columns among `columns` that a board holds to a hard WIP limit. */
export async function hardWipColumns(tx: Tx, projectId: string, columns: readonly string[]): Promise<string[]> {
  const ledger = wipLedger(tx, projectId);
  const out: string[] = [];
  for (const c of columns) if ((await ledger.boardsFor(c)).length > 0) out.push(c);
  return out;
}

/** Does the workflow hold moves into `column` to the boards' WIP limits? */
const keepsWip = (wf: GoverningWorkflow, column: string) =>
  wf.compiled.definition.transitions.some((t) => t.to === column && t.validate?.some((v) => v.kind === "wipLimit"));

const usesKind = (def: WorkflowDefinition, kinds: readonly string[]) =>
  def.transitions.some((t) => nodes(t.restrict).some((n) => "kind" in n && kinds.includes(n.kind)));

/**
 * The open workflow for a project: its statuses, a global transition into each,
 * and the checks the board has always made. Generated, never stored.
 */
export function openWorkflow(
  statuses: readonly { key: string; name: string; category: ColumnCategory; sortOrder: number; archived: boolean }[],
  opts: { blockParentWithOpenChildren: boolean },
): WorkflowDefinition {
  const def = buildOpenDefinition(statuses);
  const category = new Map(statuses.map((s) => [s.key, s.category]));
  return {
    ...def,
    transitions: def.transitions.map((t) => {
      const validate: ValidatorSpec[] = [{ kind: "wipLimit", scope: "board", hard: true }];
      const to = category.get(t.to);
      if (to === "CANCELLED") validate.push({ kind: "cancelReason" });
      if (to === "DONE" && opts.blockParentWithOpenChildren) validate.push({ kind: "childrenSettled" });
      return { ...t, validate };
    }),
  };
}

/** Resolves and caches the governing workflow per type for one change. */
export function workflowResolver(tx: Tx, orgId: string, projectId: string) {
  let open: Promise<GoverningWorkflow> | null = null;
  let statusCategories: Promise<Map<string, ColumnCategory>> | null = null;
  let orgSettings: Promise<WorkflowSettings> | null = null;
  const byType = new Map<string, Promise<GoverningWorkflow>>();

  const settings = () =>
    (orgSettings ??= tx.organization
      .findUnique({ where: { id: orgId }, select: { settings: true } })
      .then((o) => workflowSettings(o?.settings)));

  const categories = () =>
    (statusCategories ??= loadStatuses(tx, projectId, { includeArchived: true }).then(
      (rows) => new Map(rows.map((r) => [r.key, r.category])),
    ));

  const openFor = () =>
    (open ??= (async () => {
      const [rows, s] = await Promise.all([loadStatuses(tx, projectId, { includeArchived: true }), settings()]);
      const def = openWorkflow(rows.map((r) => ({ ...r, archived: r.archivedAt !== null })), s);
      return {
        compiled: compileWorkflow(def),
        workflowId: null,
        versionId: null,
        shadow: false,
        categories: await categories(),
      };
    })());

  const resolve = (workItemTypeId: string | null): Promise<GoverningWorkflow> => {
    const key = workItemTypeId ?? "";
    const hit = byType.get(key);
    if (hit) return hit;
    const p = (async () => {
      const assignments = await tx.workflowAssignment.findMany({
        where: { projectId, OR: [{ workItemTypeId }, { workItemTypeId: null }] },
        select: {
          workItemTypeId: true,
          workflow: {
            select: {
              id: true,
              enforcement: true,
              publishedVersion: { select: { id: true, definition: true } },
            },
          },
        },
      });
      // The type's own row wins over the project default.
      const row = assignments.find((a) => a.workItemTypeId !== null) ?? assignments.find((a) => a.workItemTypeId === null);
      const version = row?.workflow.publishedVersion;
      if (!row || !version) return openFor();
      const parsed = workflowDefinitionSchema.safeParse(version.definition);
      if (!parsed.success) {
        // One corrupt row must not block every edit in the project: it runs
        // the open workflow until someone republishes, and says so in the log.
        console.error(`[workflow] version ${version.id} of workflow ${row.workflow.id} does not parse; running the open workflow`, parsed.error.issues.slice(0, 3));
        return openFor();
      }
      const def = parsed.data;
      return {
        compiled: compiledVersion(version.id, def),
        workflowId: row.workflow.id,
        versionId: version.id,
        shadow: row.workflow.enforcement === "SHADOW",
        categories: await categories(),
      };
    })();
    byType.set(key, p);
    return p;
  };
  return Object.assign(resolve, { settings });
}

/** The item as conditions and validators read it, with `patch` applied on top. */
export function conditionItem(item: WorkItem, assigneeIds: readonly string[], patch: WorkItemPatch = {}): ConditionItem {
  const pick = <K extends keyof WorkItemPatch>(k: K, current: unknown) => (patch[k] !== undefined ? patch[k] : current);
  const existingCustom =
    item.customFields && typeof item.customFields === "object" && !Array.isArray(item.customFields)
      ? (item.customFields as Record<string, unknown>)
      : {};
  const assigneeId = patch.assigneeIds !== undefined ? (patch.assigneeIds[0] ?? null) : pick("assigneeId", item.assigneeId);
  return {
    createdById: item.createdById,
    assigneeIds: patch.assigneeIds ?? (patch.assigneeId !== undefined ? (patch.assigneeId ? [patch.assigneeId] : []) : assigneeIds),
    teamId: (pick("teamId", item.teamId) as string | null) ?? null,
    fields: {
      assigneeId,
      priority: pick("priority", item.priority),
      storyPoints: pick("storyPoints", item.storyPoints),
      dueDate: pick("dueDate", item.dueDate),
      startDate: pick("startDate", item.startDate),
      intervalId: pick("intervalId", item.intervalId),
      teamId: pick("teamId", item.teamId),
      description: pick("description", item.description),
      resolution: pick("resolution", item.resolution),
      workCategory: pick("workCategory", item.workCategory),
      labels: pick("tags", item.tags),
      cancelReason: pick("cancelReason", item.cancelReason),
      cancelNote: pick("cancelNote", item.cancelNote),
    },
    customFields: { ...existingCustom, ...(patch.customFields ?? {}) },
  };
}

/** The actor as conditions read it. Project role and teams are loaded only when a restriction needs them. */
async function conditionActor(tx: Tx, ctx: AuthContext, projectId: string, needsProject: boolean): Promise<ConditionActor> {
  if (!needsProject) return { userId: ctx.userId, orgRole: ctx.orgRole, permissions: ctx.permissions };
  const [member, teams] = await Promise.all([
    tx.projectMember.findFirst({
      where: { projectId, orgMember: { orgId: ctx.orgId, userId: ctx.userId } },
      select: { role: true },
    }),
    tx.teamMember.findMany({
      where: { team: { projectId }, projectMember: { projectId, orgMember: { orgId: ctx.orgId, userId: ctx.userId } } },
      select: { teamId: true },
    }),
  ]);
  return {
    userId: ctx.userId,
    orgRole: ctx.orgRole,
    permissions: ctx.permissions,
    projectRole: member?.role ?? null,
    teamIds: teams.map((t) => t.teamId),
  };
}

/**
 * The actor's facts, loaded once per call and only as deep as a workflow needs.
 * A bulk edit or a moves map spans types, and one type's workflow may ask about
 * project roles or teams when the first one's did not.
 */
function actorLoader(tx: Tx, actor: AuthContext, projectId: string) {
  let loaded: { full: boolean; facts: ConditionActor } | null = null;
  return async (def: WorkflowDefinition): Promise<ConditionActor> => {
    const needsProject = usesKind(def, ["actorProjectRole", "actorInTeam"]);
    if (!loaded || (needsProject && !loaded.full)) {
      loaded = { full: needsProject, facts: await conditionActor(tx, actor, projectId, needsProject) };
    }
    return loaded.facts;
  };
}

/** The previous status and who last took each named transition, from the item's history. */
async function conditionHistory(tx: Tx, itemId: string): Promise<ConditionHistory> {
  const rows = await tx.activity.findMany({
    where: { workItemId: itemId, OR: [{ field: "columnKey" }, { action: "transitioned", field: "transition" }] },
    orderBy: { createdAt: "desc" },
    select: { field: true, oldValue: true, newValue: true, userId: true },
    take: 200,
  });
  const lastTransitionActor: Record<string, string> = {};
  for (const r of rows) {
    if (r.field === "transition" && r.newValue && r.userId && !(r.newValue in lastTransitionActor)) {
      lastTransitionActor[r.newValue] = r.userId;
    }
  }
  return { previousStatus: rows.find((r) => r.field === "columnKey")?.oldValue ?? null, lastTransitionActor };
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * What the transition asks for, with what is still missing on the proposed
 * item. A type's required custom fields join the list on a move into In
 * progress or Done (design §7, Q6): enforcing them on every edit would lock
 * items that predate the flag.
 */
async function inputFields(
  tx: Tx,
  t: TransitionSpec,
  destCategory: ColumnCategory | undefined,
  workItemTypeId: string,
  settings: WorkflowSettings,
): Promise<{ field: FieldRef; required: boolean; label?: string; options?: TransitionInputField["options"] }[]> {
  // The fixed choices for the system fields that have them.
  const asked: { field: FieldRef; required: boolean; label?: string; options?: TransitionInputField["options"] }[] = (
    t.input ?? []
  ).map((a) => {
    if ("system" in a.field && a.field.system === "resolution") {
      return { ...a, options: settings.resolutions.map((r) => ({ value: r, label: r })) };
    }
    if ("system" in a.field && a.field.system === "cancelReason") {
      return { ...a, options: CANCEL_REASONS.map((r) => ({ value: r.value, label: r.label, hint: r.hint })) };
    }
    return a;
  });
  if (destCategory === "IN_PROGRESS" || destCategory === "DONE") {
    const required = await tx.workItemTypeField.findMany({
      where: { workItemTypeId, required: true },
      orderBy: { sortOrder: "asc" },
      select: { customField: { select: { key: true, name: true, options: true } } },
    });
    for (const r of required) {
      if (asked.some((a) => "custom" in a.field && a.field.custom === r.customField.key)) continue;
      const options = Array.isArray(r.customField.options) ? (r.customField.options as unknown[]).map(String) : [];
      asked.push({
        field: { custom: r.customField.key },
        required: true,
        label: r.customField.name,
        ...(options.length > 0 && { options: options.map((o) => ({ value: o, label: o })) }),
      });
    }
  }
  return asked;
}

/** Load only the facts the validators need; a missing one fails closed in runValidators. */
async function validationFacts(
  tx: Tx,
  args: {
    validators: readonly ValidatorSpec[];
    item: WorkItem;
    patch: WorkItemPatch;
    to: string;
    wf: GoverningWorkflow;
    wip: WipLedger;
    /** The item's team once the change is done, its actions included. */
    teamId: string | null;
  },
): Promise<ValidationFacts> {
  const kinds = new Set(args.validators.map((v) => v.kind));
  const facts: ValidationFacts = {};
  const keysOf = (cat: ColumnCategory) =>
    new Set([...args.wf.categories].filter(([, c]) => c === cat).map(([k]) => k));

  if (kinds.has("childrenSettled")) {
    // The item and its parent rows are locked for the change (lockMoves).
    const children = await tx.workItem.findMany({
      where: { parentId: args.item.id, archivedAt: null },
      orderBy: { sortOrder: "asc" },
      select: { id: true, title: true, columnKey: true },
    });
    facts.children = { items: children, doneKeys: keysOf("DONE"), cancelledKeys: keysOf("CANCELLED") };
  }
  if (kinds.has("linksSettled")) {
    const links = await tx.workItemLink.findMany({
      where: { sourceItemId: args.item.id },
      select: { type: true, targetItem: { select: { title: true, columnKey: true } } },
    });
    const settled = new Set([...keysOf("DONE"), ...keysOf("CANCELLED")]);
    const byType: Record<string, { title: string; settled: boolean }[]> = {};
    for (const v of args.validators) if (v.kind === "linksSettled") byType[v.linkType] = [];
    for (const l of links) {
      (byType[l.type] ??= []).push({ title: l.targetItem.title, settled: settled.has(l.targetItem.columnKey) });
    }
    facts.links = byType;
  }
  if (kinds.has("wipLimit")) {
    // Every board in the project with a hard limit on the destination column
    // holds, whichever surface the move comes from: the detail panel, bulk, the
    // API and the assistant as much as a drag on that board. Moves into the
    // column take turns (lockMoves), so the count is current.
    facts.wip = await args.wip.check(args.item, args.to, args.teamId);
  }
  if (kinds.has("intervalRequired")) {
    const [type, intervals] = await Promise.all([
      tx.workItemType.findUnique({ where: { id: args.patch.workItemTypeId ?? args.item.workItemTypeId }, select: { key: true } }),
      tx.interval.count({ where: { projectId: args.item.projectId } }),
    ]);
    facts.interval = { typeKey: type?.key ?? null, projectHasIntervals: intervals > 0 };
  }
  if (kinds.has("cancelReason")) {
    facts.cancel = {
      reason: args.patch.cancelReason ?? null,
      note: args.patch.cancelNote ?? null,
    };
  }
  return facts;
}

/**
 * Check a change against each item's workflow.
 *
 * `actor` is null for a system change (a merge, the cancel path's own status),
 * which is held to the structure only: the status must be one the workflow has.
 */
export async function gateChange(
  tx: Tx,
  args: {
    orgId: string;
    projectId: string;
    actor: AuthContext | null;
    actorId: string;
    level: EnforcementLevel;
    items: readonly WorkItem[];
    patch: WorkItemPatch;
    transition?: TransitionRequest;
    boardId?: string;
    now: Date;
  },
): Promise<GateResult> {
  const result: GateResult = { gates: [], denials: [], shadow: [], forced: [] };
  // A type named in the patch comes from the request: it must be this org's
  // own or a built-in one before its workflow or its required fields are read.
  if (args.patch.workItemTypeId) {
    const ok = await tx.workItemType.count({
      where: { id: args.patch.workItemTypeId, OR: [{ orgId: args.orgId }, { orgId: null }] },
    });
    if (ok === 0) throw new NotFoundError("Work item type not found");
  }
  if (args.level === "none") {
    for (const item of args.items) result.gates.push({ itemId: item.id, patch: args.patch, transitionId: null, comments: [], watchers: [] });
    return result;
  }
  const wip = wipLedger(tx, args.projectId);
  if (args.patch.columnKey || args.patch.teamId !== undefined) await lockMoves(tx, args.projectId, args.patch, args.items, wip);
  const governing = workflowResolver(tx, args.orgId, args.projectId);
  const force = args.transition?.force === true;
  if (force && !(args.actor && hasPermission(args.actor.permissions, Permission.WORKFLOW_OVERRIDE))) {
    // Asking to force without the right is refused outright, never downgraded.
    for (const item of args.items) {
      result.denials.push(
        deny(item.id, { error: "Forcing a status change needs the workflow override permission.", code: "transition_forbidden" }),
      );
    }
    return result;
  }
  const assignees = new Map<string, string[]>();
  const needsAssignees = args.level === "full";
  if (needsAssignees && args.items.length > 0) {
    const rows = await tx.workItemAssignee.findMany({
      where: { workItemId: { in: args.items.map((i) => i.id) } },
      orderBy: { sortOrder: "asc" },
      select: { workItemId: true, userId: true },
    });
    for (const r of rows) assignees.set(r.workItemId, [...(assignees.get(r.workItemId) ?? []), r.userId]);
  }
  const actorFor = args.actor ? actorLoader(tx, args.actor, args.projectId) : null;

  for (const item of args.items) {
    const typeId = args.patch.workItemTypeId ?? item.workItemTypeId;
    const wf = await governing(typeId);
    const to = args.patch.columnKey ?? item.columnKey;
    const refuse = (body: TransitionErrorBody) => {
      const d = deny(item.id, body);
      if (force && body.code !== "transition_not_allowed") {
        result.forced.push(d);
        return false;
      }
      if (wf.shadow) {
        result.shadow.push(d);
        return false;
      }
      result.denials.push(d);
      return true;
    };

    // A new type brings its own workflow, which must have the item's status.
    if (args.patch.workItemTypeId && args.patch.workItemTypeId !== item.workItemTypeId && !wf.compiled.statusKeys.has(to)) {
      if (refuse({
        error: "This type's workflow doesn't have the item's status. Pick one it has.",
        code: "type_change_needs_status",
        statuses: [...wf.compiled.statusKeys],
      })) continue;
    }

    const moving = args.patch.columnKey !== undefined && args.patch.columnKey !== null && args.patch.columnKey !== item.columnKey;
    if (!moving) {
      // Not a move: the current status's field rules still hold.
      const status = wf.compiled.definition.statuses.find((s) => s.key === item.columnKey);
      const proposed = conditionItem(item, assignees.get(item.id) ?? [], args.patch);
      const reasons = (status?.fieldRules ?? []).flatMap((r) => {
        const touched = "custom" in r.field ? args.patch.customFields?.[r.field.custom] !== undefined : fieldTouched(args.patch, r.field.system);
        if (r.rule === "readOnly" && touched) return [{ validator: "field", message: `${label(r.field)} can't be changed in this status.`, fields: [r.field] }];
        if (r.rule === "required" && touched && isEmpty(fieldOf(proposed, r.field))) return [{ validator: "fieldsRequired", message: `${label(r.field)} is required in this status.`, fields: [r.field] }];
        return [];
      });
      if (args.level === "full" && reasons.length > 0 && refuse({ error: reasons[0].message, code: "transition_invalid", reasons })) continue;
      // A new team puts the item on that team's boards, in the column it is in:
      // their hard limits hold as for a move, where the workflow keeps WIP limits.
      if (args.patch.teamId !== undefined && args.patch.teamId !== item.teamId && keepsWip(wf, item.columnKey)) {
        const fact = await wip.check(item, item.columnKey, args.patch.teamId);
        const failed = runValidators([{ kind: "wipLimit", scope: "board", hard: true }], conditionItem(item, []), { wip: fact });
        if (failed.length > 0 && refuse({ error: failed[0].message, code: "transition_invalid", reasons: failed.map((f) => ({ validator: f.validator, message: f.message })) })) continue;
        await wip.admit(item, item.columnKey, args.patch.teamId);
      }
      result.gates.push({ itemId: item.id, patch: args.patch, transitionId: null, comments: [], watchers: [] });
      continue;
    }

    const resolved = resolveTransition(wf.compiled, { from: item.columnKey, to, transitionId: args.transition?.id });
    if (!resolved.ok) {
      const body: TransitionErrorBody =
        resolved.code === "transition_ambiguous"
          ? { error: resolved.message, code: resolved.code, candidates: resolved.candidates }
          : { error: resolved.message, code: resolved.code };
      // Not even an override invents a way between statuses the workflow lacks,
      // unless the status itself exists in it.
      if (force && wf.compiled.statusKeys.has(to)) {
        result.forced.push(deny(item.id, body));
        result.gates.push({ itemId: item.id, patch: args.patch, transitionId: null, comments: [], watchers: [] });
        continue;
      }
      if (wf.shadow && wf.compiled.statusKeys.has(to)) {
        result.shadow.push(deny(item.id, body));
        result.gates.push({ itemId: item.id, patch: args.patch, transitionId: null, comments: [], watchers: [] });
        continue;
      }
      result.denials.push(deny(item.id, body));
      continue;
    }
    const t = resolved.transition;
    const transitionRef = { id: t.id, name: t.name, to: t.to };
    const named = t.id !== openTransitionId(t.to) ? t.id : null;

    if (args.level === "structural") {
      result.gates.push({ itemId: item.id, patch: args.patch, transitionId: named, comments: [], watchers: [] });
      continue;
    }

    const person = args.level === "full";

    // Restrict: who may take it. Hidden transitions are for the system only.
    if (t.hidden && person) {
      if (refuse({ error: "That transition isn't available.", code: "transition_not_allowed", transition: transitionRef })) continue;
    } else if (t.restrict && args.actor && person) {
      const ctx: ConditionContext = {
        actor: await actorFor!(wf.compiled.definition),
        item: conditionItem(item, assignees.get(item.id) ?? []),
        ...(usesKind(wf.compiled.definition, ["previousStatus", "actorIsNot"]) && { history: await conditionHistory(tx, item.id) }),
      };
      if (!restrictionAllows(t.restrict, ctx)) {
        if (refuse({ error: `You can't ${t.name}.`, code: "transition_forbidden", transition: transitionRef })) continue;
      }
    }

    // Request input: fold in what the transition asks for, then see what is still missing.
    const destCategory = wf.categories.get(to);
    const asked = await inputFields(tx, t, destCategory, typeId, await governing.settings());
    let patch = applyInput(args.patch, asked, args.transition?.input ?? {});
    const proposed = conditionItem(item, assignees.get(item.id) ?? [], patch);
    const missing = asked.filter((a) => a.required && isEmpty(fieldOf(proposed, a.field)));
    if (missing.length > 0 && person) {
      if (refuse({
        error: `${t.name} needs ${missing.map((m) => m.label ?? label(m.field)).join(", ")}.`,
        code: "transition_input_required",
        transition: transitionRef,
        fields: asked.map((a) => ({ field: a.field, required: a.required, ...(a.label && { label: a.label }), ...(a.options && { options: a.options }) })),
      })) continue;
    }

    // The transition's actions, worked out now (they are pure) so a check that
    // depends on where the item ends up sees it: a team an action sets is the
    // team whose boards' limits hold. They join the patch once the checks pass.
    const done = applyActions(t.actions ?? [], {
      patch,
      item: { createdById: item.createdById, assigneeId: item.assigneeId, tags: item.tags },
      actorId: args.actorId,
      now: args.now,
    });
    const finalTeam = done.patch.teamId !== undefined ? done.patch.teamId : item.teamId;

    // Validate: the transition's checks and the destination's required fields, on the item as it would be.
    const dest = wf.compiled.definition.statuses.find((s) => s.key === to);
    const required = (dest?.fieldRules ?? []).filter((r) => r.rule === "required").map((r) => r.field);
    const validators: ValidatorSpec[] = [...(t.validate ?? []), ...(required.length > 0 ? [{ kind: "fieldsRequired" as const, fields: required }] : [])];
    if (validators.length > 0) {
      const facts = await validationFacts(tx, { validators, item, patch, to, wf, wip, teamId: finalTeam });
      const failures = runValidators(validators, proposed, facts);
      if (failures.length > 0) {
        if (refuse({
          error: failures[0].message,
          code: "transition_invalid",
          transition: transitionRef,
          reasons: failures.map((f) => ({ validator: f.validator, message: f.message, ...(f.fields && { fields: f.fields }) })),
        })) continue;
      }
    }

    // Perform: the transition's actions join the patch; the system steps run after them.
    patch = done.patch;
    if (validators.some((v) => v.kind === "wipLimit")) await wip.admit(item, to, finalTeam);
    result.gates.push({ itemId: item.id, patch, transitionId: named, comments: done.comments, watchers: done.watchers });
  }
  return result;
}

/** One item's change, or the refusal it ran into, as an error. */
export function throwIfDenied(result: GateResult): void {
  const d = result.denials[0];
  if (d) throw new TransitionError(d.body);
}

const PATCH_FIELDS: Record<string, readonly (keyof WorkItemPatch)[]> = {
  assigneeId: ["assigneeId", "assigneeIds"],
  labels: ["tags"],
};

function fieldTouched(patch: WorkItemPatch, system: string): boolean {
  return (PATCH_FIELDS[system] ?? [system as keyof WorkItemPatch]).some((k) => patch[k] !== undefined);
}

function fieldOf(item: ConditionItem, field: FieldRef): unknown {
  return "custom" in field ? item.customFields[field.custom] : item.fields[field.system];
}

const SYSTEM_LABELS: Record<string, string> = {
  assigneeId: "Assignee",
  priority: "Priority",
  storyPoints: "Story points",
  dueDate: "Due date",
  startDate: "Start date",
  intervalId: "Sprint",
  teamId: "Team",
  description: "Description",
  resolution: "Resolution",
  workCategory: "Work category",
  labels: "Labels",
  cancelReason: "Cancel reason",
  cancelNote: "Note",
};

function label(field: FieldRef): string {
  return "custom" in field ? field.custom : (SYSTEM_LABELS[field.system] ?? field.system);
}

/**
 * The transitions an actor may take on an item from its current status: what
 * the detail sheet's status menu, the board and the assistant offer. Hidden
 * transitions are left out and restrictions are evaluated, fail-closed, so a
 * transition listed here passes Restrict; its checks still run on the move.
 */
export async function listTransitions(
  tx: Tx,
  args: { orgId: string; projectId: string; actor: AuthContext; item: WorkItem },
): Promise<AvailableTransition[]> {
  const governing = workflowResolver(tx, args.orgId, args.projectId);
  const wf = await governing(args.item.workItemTypeId);
  const candidates = wf.compiled.from(args.item.columnKey).filter((t) => !t.hidden && t.to !== args.item.columnKey);
  if (candidates.length === 0) return [];
  const def = wf.compiled.definition;
  const restricted = candidates.some((t) => t.restrict);
  const assigneeIds = restricted
    ? (await tx.workItemAssignee.findMany({ where: { workItemId: args.item.id }, orderBy: { sortOrder: "asc" }, select: { userId: true } })).map((a) => a.userId)
    : [];
  const ctx: ConditionContext | null = restricted
    ? {
        actor: await conditionActor(tx, args.actor, args.projectId, usesKind(def, ["actorProjectRole", "actorInTeam"])),
        item: conditionItem(args.item, assigneeIds),
        ...(usesKind(def, ["previousStatus", "actorIsNot"]) && { history: await conditionHistory(tx, args.item.id) }),
      }
    : null;
  const out: AvailableTransition[] = [];
  for (const t of candidates) {
    if (t.restrict && ctx && !restrictionAllows(t.restrict, ctx)) continue;
    const category = wf.categories.get(t.to);
    if (!category) continue;
    const asked = await inputFields(tx, t, category, args.item.workItemTypeId, await governing.settings());
    out.push({
      id: t.id,
      name: t.name,
      to: t.to,
      toCategory: category,
      input: asked.map((a) => ({ field: a.field, required: a.required, ...(a.label && { label: a.label }), ...(a.options && { options: a.options }) })),
    });
  }
  return out;
}

/** For each status, the statuses a move from it may lead to. */
export type MoveMap = Record<string, string[]>;

/**
 * Where an actor could move items, per type, so a board can dim the columns a
 * dragged card can't go to before the drop. Null means the open workflow
 * (anything to anything) governs. A transition whose restriction depends on
 * the item counts as possible: this map never decides a move, the server does.
 */
export async function allowedMoves(
  tx: Tx,
  args: { orgId: string; projectId: string; actor: AuthContext },
): Promise<{ default: MoveMap | null; byType: Record<string, MoveMap | null> }> {
  const assignments = await tx.workflowAssignment.findMany({
    where: { projectId: args.projectId },
    select: { workItemTypeId: true },
  });
  if (assignments.length === 0) return { default: null, byType: {} };
  const governing = workflowResolver(tx, args.orgId, args.projectId);
  const actorFor = actorLoader(tx, args.actor, args.projectId);
  const movesOf = async (wf: GoverningWorkflow): Promise<MoveMap | null> => {
    if (wf.workflowId === null) return null;
    const actor = await actorFor(wf.compiled.definition);
    const map: MoveMap = {};
    for (const status of wf.compiled.statusKeys) {
      const to = wf.compiled
        .from(status)
        .filter((t) => !t.hidden && t.to !== status && restrictionMayAllow(t.restrict, actor))
        .map((t) => t.to);
      map[status] = [...new Set(to)];
    }
    return map;
  };
  // A type without a row of its own follows the project default.
  const byType: Record<string, MoveMap | null> = {};
  for (const a of assignments) {
    if (a.workItemTypeId) byType[a.workItemTypeId] = await movesOf(await governing(a.workItemTypeId));
  }
  return { default: await movesOf(await governing(null)), byType };
}

/** What the simulate panel says about one transition out of an item's status. */
export interface SimulatedTransition {
  id: string;
  name: string;
  to: string;
  toCategory: ColumnCategory | null;
  /**
   * available: the actor could take it now. needs_input: they could, once they
   * fill in what it asks for. blocked: its checks fail on the item as it is.
   * restricted: the actor may not take it. hidden: only the system may.
   */
  outcome: "available" | "needs_input" | "blocked" | "restricted" | "hidden";
  reasons: string[];
  input: TransitionInputField[];
}

/**
 * "Simulate": every transition out of an item's current status and what would
 * happen if `actor` took it, under the governing workflow or under `definition`
 * (a draft, to try before publishing). The same restrictions, input and checks
 * the server applies on a move; nothing is written.
 */
export async function simulateTransitions(
  tx: Tx,
  args: { orgId: string; projectId: string; actor: AuthContext; item: WorkItem; definition?: WorkflowDefinition },
): Promise<{ status: string; inWorkflow: boolean; transitions: SimulatedTransition[] }> {
  const governing = workflowResolver(tx, args.orgId, args.projectId);
  const live = await governing(args.item.workItemTypeId);
  const wf: GoverningWorkflow = args.definition
    ? { compiled: compileWorkflow(args.definition), workflowId: null, versionId: null, shadow: false, categories: live.categories }
    : live;
  const def = wf.compiled.definition;
  const assigneeIds = (
    await tx.workItemAssignee.findMany({ where: { workItemId: args.item.id }, orderBy: { sortOrder: "asc" }, select: { userId: true } })
  ).map((a) => a.userId);
  const ctx: ConditionContext = {
    actor: await conditionActor(tx, args.actor, args.projectId, usesKind(def, ["actorProjectRole", "actorInTeam"])),
    item: conditionItem(args.item, assigneeIds),
    ...(usesKind(def, ["previousStatus", "actorIsNot"]) && { history: await conditionHistory(tx, args.item.id) }),
  };
  const settings = await governing.settings();
  // One move at a time: nothing is admitted, and simulate takes no locks.
  const simulatedWip = wipLedger(tx, args.projectId);
  const out: SimulatedTransition[] = [];
  for (const t of wf.compiled.from(args.item.columnKey)) {
    if (t.to === args.item.columnKey) continue;
    const category = wf.categories.get(t.to) ?? null;
    const asked = await inputFields(tx, t, category ?? undefined, args.item.workItemTypeId, settings);
    const input = asked.map((a) => ({ field: a.field, required: a.required, ...(a.label && { label: a.label }), ...(a.options && { options: a.options }) }));
    const base = { id: t.id, name: t.name, to: t.to, toCategory: category, input };
    if (t.hidden) {
      out.push({ ...base, outcome: "hidden", reasons: ["Hidden: only the system and automations take it."] });
      continue;
    }
    if (t.restrict && !restrictionAllows(t.restrict, ctx)) {
      out.push({ ...base, outcome: "restricted", reasons: ["The actor doesn't meet this transition's restriction."] });
      continue;
    }
    const patch: WorkItemPatch = { columnKey: t.to };
    const proposed = conditionItem(args.item, assigneeIds, patch);
    const dest = def.statuses.find((s) => s.key === t.to);
    const required = (dest?.fieldRules ?? []).filter((r) => r.rule === "required").map((r) => r.field);
    const validators: ValidatorSpec[] = [...(t.validate ?? []), ...(required.length > 0 ? [{ kind: "fieldsRequired" as const, fields: required }] : [])];
    // A check on a field the transition asks for is the dialog's job, not a block.
    const askedKeys = new Set(asked.map((a) => JSON.stringify(a.field)));
    const failures = validators.length > 0
      ? runValidators(validators, proposed, await validationFacts(tx, { validators, item: args.item, patch, to: t.to, wf, wip: simulatedWip, teamId: args.item.teamId }))
          .filter((f) => !f.fields?.length || !f.fields.every((field) => askedKeys.has(JSON.stringify(field))))
      : [];
    if (failures.length > 0) {
      out.push({ ...base, outcome: "blocked", reasons: failures.map((f) => f.message) });
      continue;
    }
    const missing = asked.filter((a) => a.required && isEmpty(fieldOf(proposed, a.field)));
    out.push(
      missing.length > 0
        ? { ...base, outcome: "needs_input", reasons: missing.map((m) => `Asks for ${m.label ?? label(m.field)}.`) }
        : { ...base, outcome: "available", reasons: [] },
    );
  }
  return { status: args.item.columnKey, inWorkflow: wf.compiled.statusKeys.has(args.item.columnKey), transitions: out };
}
