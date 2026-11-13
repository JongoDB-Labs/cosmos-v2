import { z } from "zod";
import { Priority, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { requireAccess } from "@/lib/abac/require-access";
import { executeCql } from "@/lib/query/execute.server";
import { CqlError } from "@/lib/query/errors";
import { CQL_LIMITS } from "@/lib/query/ast";
import { applyWorkItemChange, type WorkItemPatch } from "@/lib/work-items/apply-change.server";
import { mergeEffects, runAfterCommit, type AfterCommitEffects } from "@/lib/work-items/after-commit";
import { assertProjectManage, assertProjectRead, loadAuthContext, type ToolContext } from "./_ctx";
import type { AuthContext } from "@/lib/rbac/check";
import { cqlOrg, diagnosticsForModel } from "./cql";
import { BULK_TOOL_MAX } from "../tools/bulk";

/**
 * bulk_update_work_items — one change (status, assignee, sprint, labels,
 * priority) to many items, chosen by a query or by id.
 *
 * Mirrors `PUT /projects/:projectId/work-items/bulk`, project by project: the
 * project must be visible and the caller must hold ITEM_BULK_EDIT org-wide or
 * manage that project (`requireProjectManage`, the route's own gate). On top of
 * that every ROW is held to the single-item edit gate (`requireAccess(…,
 * "ITEM_UPDATE", row)`), so a deny policy that stops someone editing an item
 * one at a time stops them here too. Rows that fail are skipped and reported
 * with the reason, and the rest of the selection still changes, as the bulk
 * route does for a workflow refusal.
 *
 * Capped at BULK_TOOL_MAX: a query that matches more is refused whole rather
 * than applied to a first page. The agent loop runs it only after the user
 * has confirmed a preview (ai/confirmation.ts, using `bulkTargetIds` below).
 */

const SELF = new Set(["me", "@me", "self", "myself"]);

const schema = z
  .object({
    cql: z.string().trim().min(1).max(CQL_LIMITS.textLength).optional(),
    ids: z.array(z.string().uuid()).min(1).max(BULK_TOOL_MAX).optional(),
    status: z.string().trim().min(1).max(100).optional(),
    assigneeId: z.union([z.string().uuid(), z.null()]).optional(),
    priority: z.nativeEnum(Priority).optional(),
    intervalId: z.union([z.string().uuid(), z.null()]).optional(),
    addLabels: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    removeLabels: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  })
  .refine((d) => (d.cql === undefined) !== (d.ids === undefined), { message: "Give exactly one of cql or ids" })
  .refine(
    (d) =>
      d.status !== undefined || d.assigneeId !== undefined || d.priority !== undefined ||
      d.intervalId !== undefined || !!d.addLabels?.length || !!d.removeLabels?.length,
    { message: "Nothing to change: give a status, assignee, priority, sprint or labels" },
  );

interface Row {
  id: string;
  projectId: string;
  ticketKey: string;
  createdById: string;
  assigneeId: string | null;
  tags: string[];
}

type Skip = { id: string; ticketKey?: string; reason: string };

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

/** The rows ids name, in this org. Ids that name nothing are reported, not guessed at. */
async function rowsByIds(orgId: string, ids: string[]): Promise<{ rows: Row[]; missing: string[] }> {
  const found = await prisma.workItem.findMany({
    where: { id: { in: ids }, orgId },
    select: { id: true, projectId: true, ticketNumber: true, createdById: true, assigneeId: true, tags: true, project: { select: { key: true } } },
  });
  const byId = new Map(found.map((r) => [r.id, r]));
  return {
    rows: found.map((r) => ({
      id: r.id, projectId: r.projectId, ticketKey: `${r.project.key}-${r.ticketNumber}`,
      createdById: r.createdById, assigneeId: r.assigneeId, tags: r.tags,
    })),
    missing: ids.filter((id) => !byId.has(id)),
  };
}

type Parsed = z.infer<typeof schema>;
type Refusal = { error: string; diagnostics?: unknown };

/** The input as the executor reads it: "me" is the caller, "none" clears. */
function parseInput(input: Record<string, unknown>, ctx: ToolContext): { d: Parsed } | Refusal {
  const raw = { ...input };
  if (typeof raw.assigneeId === "string" && SELF.has(raw.assigneeId.trim().toLowerCase())) raw.assigneeId = ctx.userId;
  // "none" (or an empty string) clears: unassign, or take out of the sprint.
  for (const k of ["assigneeId", "intervalId"] as const) {
    if (typeof raw[k] === "string" && ["none", ""].includes((raw[k] as string).trim().toLowerCase())) raw[k] = null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { d: parsed.data } : invalid(parsed.error);
}

/** The rows the query or the ids choose, and the ids that name nothing. */
async function selectRows(d: Parsed, ctx: ToolContext, auth: AuthContext): Promise<{ rows: Row[]; skipped: Skip[] } | Refusal> {
  const skipped: Skip[] = [];
  if (d.cql) {
    const org = await cqlOrg(ctx);
    if ("error" in org) return org;
    let result;
    try {
      // The Issues list's own engine, as the caller: only items they can read.
      result = await executeCql(auth, { cql: d.cql }, { pageSize: BULK_TOOL_MAX });
    } catch (e) {
      if (e instanceof CqlError) {
        return { error: `${e.message} Fix the query and try again.`, diagnostics: diagnosticsForModel(e.diagnostics) };
      }
      throw e;
    }
    if (result.total === null || result.total > BULK_TOOL_MAX) {
      return {
        error:
          `That query matches ${result.total === null ? "too many items to count quickly" : `${result.total} items`}; ` +
          `the assistant changes at most ${BULK_TOOL_MAX} at a time. Narrow the query, or use the Issues list's bulk edit.`,
      };
    }
    // `executeCql` already scoped the rows to readable projects; the owner and
    // assignee for the row gate come from the rows themselves.
    const meta = await prisma.workItem.findMany({
      where: { id: { in: result.data.map((r) => r.id) }, orgId: ctx.orgId },
      select: { id: true, createdById: true },
    });
    const owner = new Map(meta.map((m) => [m.id, m.createdById]));
    const rows = result.data.map((r) => ({
      id: r.id, projectId: r.project.id, ticketKey: r.ticketKey,
      createdById: owner.get(r.id) ?? r.reporter?.id ?? "", assigneeId: r.assignee?.id ?? null, tags: r.tags,
    }));
    return { rows, skipped };
  }
  const byIds = await rowsByIds(ctx.orgId, d.ids!);
  for (const id of byIds.missing) skipped.push({ id, reason: "Work item not found" });
  return { rows: byIds.rows, skipped };
}

/**
 * The items a call would act on, for the confirmation preview (see
 * ai/confirmation.ts): the selection resolved exactly as the executor resolves
 * it, less any row in a project the caller may not read, which the executor
 * reports as not found and never touches. An input the executor would refuse
 * comes back as that refusal, so the model gets the same answer either way.
 */
export async function bulkTargetIds(input: Record<string, unknown>, ctx: ToolContext): Promise<{ ids: string[] } | { refusal: Refusal }> {
  const p = parseInput(input, ctx);
  if ("error" in p) return { refusal: p };
  const auth = await loadAuthContext(ctx);
  if (!auth) return { refusal: { error: "Insufficient permissions" } };
  const sel = await selectRows(p.d, ctx, auth);
  if ("error" in sel) return { refusal: sel };
  const readable = new Map<string, boolean>();
  const ids: string[] = [];
  for (const r of sel.rows) {
    if (!readable.has(r.projectId)) readable.set(r.projectId, !(await assertProjectRead(ctx, r.projectId, "ITEM_READ")));
    if (readable.get(r.projectId)) ids.push(r.id);
  }
  return { ids: ids.sort() };
}

export async function bulkUpdateWorkItems(input: Record<string, unknown>, ctx: ToolContext) {
  // No org-wide pre-check: the gate is per PROJECT (below), and an org-wide bit
  // in front of it would refuse a project's manager before the manager branch
  // of `assertProjectManage` is reached, which the bulk route admits.
  const p = parseInput(input, ctx);
  if ("error" in p) return p;
  const d = p.d;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };

  // ── the selection ──
  const sel = await selectRows(d, ctx, auth);
  if ("error" in sel) return sel;
  const { rows, skipped } = sel;
  if (rows.length === 0) return { matched: 0, updated: 0, items: [], skipped };

  // An assignee must be someone in this org, before anything is written.
  if (d.assigneeId) {
    const inOrg = await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId: d.assigneeId } }, select: { id: true } });
    if (!inOrg) return { error: "That assigneeId is not a member of this organization. Look the person up with list_org_members." };
  }

  // ── project by project, as the bulk route runs ──
  const byProject = new Map<string, Row[]>();
  for (const r of rows) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);

  const updated: { id: string; ticketKey: string }[] = [];
  const effectsByProject = new Map<string, AfterCommitEffects[]>();

  for (const [projectId, projectRows] of byProject) {
    // READ first, as get_work_item asks it. Ids name rows anywhere in the org,
    // so a project whose items this caller may not read is "not found": its rows
    // are never changed, and no refusal below echoes their keys. (Checked per
    // project, not per row: a read rule that names a row attribute fails closed
    // at the project, exactly as it does for one item at a time.)
    const notFound = (r: Row) => skipped.push({ id: r.id, reason: "Work item not found" });
    if (await assertProjectRead(ctx, projectId, "ITEM_READ")) {
      projectRows.forEach(notFound);
      continue;
    }
    const skipAll = (reason: string) => projectRows.forEach((r) => skipped.push({ id: r.id, ticketKey: r.ticketKey, reason }));

    // The bulk route's gate: the project is visible, and the caller holds
    // ITEM_BULK_EDIT org-wide or manages it. A row named by id in a project the
    // caller cannot open reads as not found, and its ticket key is not echoed.
    const refused = await assertProjectManage(ctx, projectId, Permission.ITEM_BULK_EDIT);
    if (refused?.error === "Project not found") {
      projectRows.forEach(notFound);
      continue;
    }
    if (refused) {
      skipAll("Changing items in bulk in this project needs the bulk-edit permission or the project's manager role");
      continue;
    }

    // The status and sprint must exist in THIS project; a selection across
    // projects only moves the items where they do.
    let columnKey: string | undefined;
    if (d.status !== undefined) {
      const status = await prisma.workflowStatus.findFirst({
        where: {
          projectId,
          archivedAt: null,
          OR: [{ key: d.status }, { name: { equals: d.status, mode: "insensitive" } }],
        },
        select: { key: true },
      });
      if (!status) {
        skipAll(`This project has no status "${d.status}"`);
        continue;
      }
      columnKey = status.key;
    }
    if (d.intervalId) {
      const interval = await prisma.interval.findFirst({ where: { id: d.intervalId, orgId: ctx.orgId, projectId }, select: { id: true } });
      if (!interval) {
        skipAll("That sprint is not in this item's project");
        continue;
      }
    }

    // Each row through the single-item edit gate (ownership / deny policies).
    const editable: Row[] = [];
    for (const r of projectRows) {
      try {
        await requireAccess(auth, "ITEM_UPDATE", { createdById: r.createdById, assigneeId: r.assigneeId, projectId });
        editable.push(r);
      } catch {
        skipped.push({ id: r.id, ticketKey: r.ticketKey, reason: "You may not edit this item" });
      }
    }
    if (editable.length === 0) continue;

    const base: WorkItemPatch = {
      ...(columnKey !== undefined ? { columnKey } : {}),
      ...(d.assigneeId !== undefined ? { assigneeId: d.assigneeId } : {}),
      ...(d.priority !== undefined ? { priority: d.priority } : {}),
      ...(d.intervalId !== undefined ? { intervalId: d.intervalId } : {}),
    };
    // Labels are per item (the write replaces the whole set), so rows are
    // grouped by the set they end up with; without a label change, one group.
    const groups = new Map<string, { patch: WorkItemPatch; rows: Row[] }>();
    for (const r of editable) {
      let patch = base;
      let key = "";
      if (d.addLabels?.length || d.removeLabels?.length) {
        const remove = new Set(d.removeLabels ?? []);
        const tags = [...new Set([...r.tags, ...(d.addLabels ?? [])])].filter((t) => !remove.has(t));
        patch = { ...base, tags };
        key = [...tags].sort().join("\u0000");
      }
      const g = groups.get(key) ?? { patch, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }

    for (const g of groups.values()) {
      const change = await prisma.$transaction((tx: Prisma.TransactionClient) =>
        applyWorkItemChange(tx, {
          actorId: ctx.userId,
          orgId: ctx.orgId,
          projectId,
          itemIds: g.rows.map((r) => r.id),
          patch: g.patch,
          // BULK: the workflow refuses items one by one and the rest still
          // change, exactly as the bulk route.
          source: "BULK",
          actor: auth,
        }),
      );
      const done = new Set(change.itemIds);
      for (const r of g.rows) if (done.has(r.id)) updated.push({ id: r.id, ticketKey: r.ticketKey });
      for (const den of change.denied) {
        const r = g.rows.find((x) => x.id === den.itemId);
        skipped.push({ id: den.itemId, ticketKey: r?.ticketKey, reason: `The workflow refused it (${den.body.code})` });
      }
      effectsByProject.set(projectId, [...(effectsByProject.get(projectId) ?? []), change.effects]);
    }
  }

  for (const parts of effectsByProject.values()) {
    const effects = mergeEffects(parts);
    if (effects) await runAfterCommit(effects);
  }

  return {
    matched: d.ids ? d.ids.length : rows.length,
    updated: updated.length,
    items: updated,
    skipped,
  };
}
