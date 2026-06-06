import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import { sumMoney, moneyToNumber } from "@/lib/money";
import { executeGoogleTool, GOOGLE_TOOL_NAMES } from "./executors/google";
import { executeGitHubTool, GITHUB_TOOL_NAMES } from "./executors/github";
import {
  createWorkItem,
  updateWorkItem,
  deleteWorkItem,
  listWorkItems,
} from "./executors/work-items";
import { createNote, updateNote, deleteNote } from "./executors/notes";
import { addComment, listComments, deleteComment } from "./executors/comments";
import { logTime, listTimeEntries } from "./executors/time";
import { logRevenue, logExpense, getFinanceSummary } from "./executors/finance";
import { getTrialBalance, getProfitAndLoss } from "./executors/accounting";
import { listProjects, listCycles, createCycle } from "./executors/projects";
import { fetchUrl } from "./executors/utility";
import { semanticSearch } from "./executors/rag";
import { canonicalizeStageFilter } from "@/lib/crm/stages";
import { Permission } from "@/lib/rbac/permissions";
import { assertPermission } from "./executors/_ctx";
import { logAudit } from "@/lib/audit";
import { queryComplianceControls, updateComplianceControl, listOrgMembers } from "./executors/compliance";

interface ToolContext {
  orgId: string;
  userId: string;
}

/**
 * A tool call parsed from a `claude` CLI text response.
 */
export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Raw `TOOL_CALL: {...}` substring that produced this call (for round-trip / debug). */
  fullMatch: string;
  /** Character offset of the `TOOL_CALL:` marker within the original text. */
  index: number;
}

/**
 * Scan `text` for `TOOL_CALL: { ... }` directives and parse each one. Skips
 * malformed JSON gracefully (logs and continues). Returns every match plus
 * the offset of the first marker so callers can split prose from tool
 * directives without re-scanning.
 *
 * Mirrors the algorithm at /home/defcon/okr-dashboard/server/index.js:6001
 * (manual brace-depth walker, string-aware so `{` and `}` inside strings
 * don't desync the parser).
 */
export function parseToolCalls(text: string): {
  toolCalls: ParsedToolCall[];
  firstMatchIndex: number;
} {
  const toolCalls: ParsedToolCall[] = [];
  const marker = "TOOL_CALL:";
  let firstMatchIndex = -1;
  let searchFrom = 0;

  while (true) {
    const mIdx = text.indexOf(marker, searchFrom);
    if (mIdx === -1) break;
    if (firstMatchIndex === -1) firstMatchIndex = mIdx;

    const braceStart = text.indexOf("{", mIdx + marker.length);
    if (braceStart === -1) break;

    let depth = 0;
    let braceEnd = -1;
    let inString = false;
    let escaped = false;
    for (let ci = braceStart; ci < text.length; ci++) {
      const ch = text[ci];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          braceEnd = ci;
          break;
        }
      }
    }

    if (braceEnd === -1) {
      searchFrom = mIdx + marker.length;
      continue;
    }

    const jsonStr = text.slice(braceStart, braceEnd + 1);
    try {
      const parsed = JSON.parse(jsonStr) as {
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof parsed.name === "string") {
        const args =
          parsed.arguments && typeof parsed.arguments === "object"
            ? (parsed.arguments as Record<string, unknown>)
            : {};
        toolCalls.push({
          name: parsed.name,
          arguments: args,
          fullMatch: text.slice(mIdx, braceEnd + 1),
          index: mIdx,
        });
      }
    } catch (err) {
      console.warn(
        `[parseToolCalls] skipping malformed JSON near offset ${mIdx}:`,
        (err as Error).message
      );
    }
    searchFrom = braceEnd + 1;
  }

  return { toolCalls, firstMatchIndex };
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const result = await dispatchTool(name, input, ctx);
  // Governance: write every *mutating* assistant tool call to the org audit
  // trail so an AI action is as traceable as a human one. Best-effort — an
  // audit failure must never change the tool result the model sees.
  await auditAssistantToolUse(name, input, result, ctx);
  return result;
}

async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  // Google Workspace tools (Gmail, Calendar, Drive, Contacts) — dispatched
  // first so each new Google tool only needs to be added to the executor's
  // own switch in `executors/google.ts`.
  if (GOOGLE_TOOL_NAMES.has(name)) {
    const result = await executeGoogleTool(name, input, { userId: ctx.userId, orgId: ctx.orgId });
    if (result !== null) return result;
  }

  // GitHub connector tools (read-only issues + PRs) — dispatched early like Google
  // so each new GitHub tool only needs adding to the executor's own switch. The
  // executor resolves the org-shared sealed PAT via getOrgCredential(orgId,'github').
  if (GITHUB_TOOL_NAMES.has(name)) {
    const result = await executeGitHubTool(name, input, { userId: ctx.userId, orgId: ctx.orgId });
    if (result !== null) return result;
  }

  switch (name) {
    // ── Legacy read-only tools (live in this file below) ───────────────
    case "query_work_items":
      return queryWorkItems(input, ctx);
    case "query_cycles":
      return queryCycles(input, ctx);
    case "query_crm":
      return queryCrm(input, ctx);
    case "query_finance":
      return queryFinance(input, ctx);
    case "generate_cycle_brief":
      return generateCycleBrief(input, ctx);
    case "process_transcript":
      return { message: "Transcript processing requires AI — handled at the chat level" };

    // ── Phase 3b: cosmos-internal CRUD tools ───────────────────────────
    case "create_work_item":
      return createWorkItem(input, ctx);
    case "update_work_item":
      return updateWorkItem(input, ctx);
    case "delete_work_item":
      return deleteWorkItem(input, ctx);
    case "list_work_items":
      return listWorkItems(input, ctx);

    case "create_note":
      return createNote(input, ctx);
    case "update_note":
      return updateNote(input, ctx);
    case "delete_note":
      return deleteNote(input, ctx);

    case "add_comment":
      return addComment(input, ctx);
    case "list_comments":
      return listComments(input, ctx);
    case "delete_comment":
      return deleteComment(input, ctx);

    case "log_time":
      return logTime(input, ctx);
    case "list_time_entries":
      return listTimeEntries(input, ctx);

    case "log_revenue":
      return logRevenue(input, ctx);
    case "log_expense":
      return logExpense(input, ctx);
    case "get_finance_summary":
      return getFinanceSummary(input, ctx);

    case "get_trial_balance":
      return getTrialBalance(input, ctx);
    case "get_profit_and_loss":
      return getProfitAndLoss(input, ctx);

    case "list_projects":
      return listProjects(input, ctx);
    case "list_cycles":
      return listCycles(input, ctx);
    case "create_cycle":
      return createCycle(input, ctx);

    case "fetch_url":
      return fetchUrl(input, ctx);

    case "semantic_search":
      return semanticSearch(input, ctx);

    // Compliance + people
    case "query_compliance_controls":
      return queryComplianceControls(input, ctx);
    case "update_compliance_control":
      return updateComplianceControl(input, ctx);
    case "list_org_members":
      return listOrgMembers(input, ctx);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Map of mutating tools → the audit (action, entity) they should record. Pure
 * read tools (query_*, list_*, get_finance_summary, semantic_search, fetch_url)
 * are intentionally absent — we only log actions that change state.
 */
const ASSISTANT_AUDIT_ACTIONS: Record<string, { action: string; entity: string }> = {
  create_work_item: { action: "assistant.work_item.created", entity: "work_item" },
  update_work_item: { action: "assistant.work_item.updated", entity: "work_item" },
  delete_work_item: { action: "assistant.work_item.deleted", entity: "work_item" },
  create_note: { action: "assistant.note.created", entity: "note" },
  update_note: { action: "assistant.note.updated", entity: "note" },
  delete_note: { action: "assistant.note.deleted", entity: "note" },
  add_comment: { action: "assistant.comment.added", entity: "comment" },
  delete_comment: { action: "assistant.comment.deleted", entity: "comment" },
  log_time: { action: "assistant.time_entry.logged", entity: "time_entry" },
  log_revenue: { action: "assistant.revenue.logged", entity: "revenue" },
  log_expense: { action: "assistant.expense.logged", entity: "expense" },
  create_cycle: { action: "assistant.cycle.created", entity: "cycle" },
  update_compliance_control: { action: "assistant.compliance_control.updated", entity: "compliance_control" },
  send_email: { action: "assistant.email.sent", entity: "email" },
  create_calendar_event: { action: "assistant.calendar_event.created", entity: "calendar_event" },
  update_calendar_event: { action: "assistant.calendar_event.updated", entity: "calendar_event" },
  delete_calendar_event: { action: "assistant.calendar_event.deleted", entity: "calendar_event" },
  create_drive_folder: { action: "assistant.drive_folder.created", entity: "drive_folder" },
};

/** Best-effort entity-id extraction from a tool result of unknown shape. */
function pickEntityId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (typeof r.id === "string") return r.id;
  for (const key of ["workItem", "note", "comment", "timeEntry", "revenue", "expense", "cycle", "event", "item"]) {
    const nested = r[key];
    if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).id === "string") {
      return (nested as Record<string, unknown>).id as string;
    }
  }
  for (const key of ["messageId", "eventId", "workItemId", "expenseId", "noteId"]) {
    if (typeof r[key] === "string") return r[key] as string;
  }
  return undefined;
}

/** Shallow, JSON-safe summary of tool arguments for audit metadata (long
 * strings truncated, nested values collapsed). */
function summarizeArgs(input: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = v.length > 300 ? v.slice(0, 300) + "…" : v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = `[${v.length} items]`;
    else if (v && typeof v === "object") out[k] = "[object]";
    // null / undefined intentionally skipped (keeps audit metadata JSON-clean)
  }
  return out;
}

async function auditAssistantToolUse(
  name: string,
  input: Record<string, unknown>,
  result: unknown,
  ctx: ToolContext
): Promise<void> {
  const mapping = ASSISTANT_AUDIT_ACTIONS[name];
  if (!mapping) return;
  // Don't record an audit entry for a tool call that failed.
  if (result && typeof result === "object" && "error" in (result as Record<string, unknown>)) return;
  try {
    await logAudit({
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: mapping.action,
      entity: mapping.entity,
      entityId: pickEntityId(result),
      metadata: { via: "assistant", tool: name, arguments: summarizeArgs(input) },
    });
  } catch (err) {
    console.warn(`[auditAssistantToolUse] failed to log ${name}:`, (err as Error).message);
  }
}

async function queryWorkItems(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;
  const where: Prisma.WorkItemWhereInput = { orgId: ctx.orgId };
  if (input.projectId) where.projectId = input.projectId as string;
  if (input.assigneeId) where.assigneeId = input.assigneeId as string;
  if (input.priority) where.priority = input.priority as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  if (input.cycleId) where.cycleId = input.cycleId as string;
  if (input.workItemTypeId) where.workItemTypeId = input.workItemTypeId as string;
  if (input.query) where.title = { contains: input.query as string, mode: "insensitive" };

  const items = await prisma.workItem.findMany({
    where,
    take: Math.min((input.limit as number) || 20, 50),
    orderBy: { updatedAt: "desc" },
    select: {
      id: true, title: true, workItemTypeId: true, columnKey: true,
      priority: true, assigneeId: true, cycleId: true,
      storyPoints: true, dueDate: true, completedAt: true,
      ticketNumber: true, tags: true,
    },
  });
  return { count: items.length, items };
}

// Note: createWorkItem / updateWorkItem now live in `executors/work-items.ts`
// (with permission gating + sector-aware type resolution). The legacy inline
// versions were removed when Phase 3b landed.

async function queryCycles(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;
  const where: Prisma.CycleWhereInput = {
    orgId: ctx.orgId,
    projectId: input.projectId as string,
  };
  if (input.status) where.status = input.status as "PLANNED" | "ACTIVE" | "COMPLETED";

  const cycles = await prisma.cycle.findMany({
    where,
    take: Math.min((input.limit as number) || 10, 20),
    orderBy: { number: "desc" },
    include: { _count: { select: { workItems: true } } },
  });
  return { count: cycles.length, cycles };
}

async function queryCrm(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.CRM_READ);
  if (denied) return denied;
  const where: Prisma.CrmContactWhereInput = { orgId: ctx.orgId };
  // Stages are stored canonical-uppercase; case-fold the filter so the LLM
  // passing "lead"/"Lead" still matches (mirrors the contacts GET route).
  if (input.stage)
    where.stage = canonicalizeStageFilter(input.stage as string);
  if (input.query) where.name = { contains: input.query as string, mode: "insensitive" };

  const contacts = await prisma.crmContact.findMany({
    where,
    take: Math.min((input.limit as number) || 20, 50),
    orderBy: { updatedAt: "desc" },
  });
  return { count: contacts.length, contacts };
}

async function queryFinance(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.FINANCE_READ);
  if (denied) return denied;
  const dateFilter: Record<string, Date> = {};
  if (input.startDate) dateFilter.gte = new Date(input.startDate as string);
  if (input.endDate) dateFilter.lte = new Date(input.endDate as string);
  const hasDate = Object.keys(dateFilter).length > 0;

  const [revenues, expenses] = await Promise.all([
    prisma.revenue.findMany({ where: { orgId: ctx.orgId, ...(hasDate && { date: dateFilter }) } }),
    prisma.expense.findMany({ where: { orgId: ctx.orgId, ...(hasDate && { date: dateFilter }) } }),
  ]);

  const totalRevenue = sumMoney(revenues.map((r) => r.amount));
  const totalExpenses = sumMoney(expenses.map((e) => e.amount));

  return {
    totalRevenue: moneyToNumber(totalRevenue),
    totalExpenses: moneyToNumber(totalExpenses),
    netIncome: moneyToNumber(totalRevenue.minus(totalExpenses)),
    revenueCount: revenues.length,
    expenseCount: expenses.length,
  };
}

async function generateCycleBrief(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;
  const projectId = input.projectId as string;
  let cycle;

  if (input.cycleId) {
    cycle = await prisma.cycle.findFirst({ where: { id: input.cycleId as string, orgId: ctx.orgId } });
  } else {
    cycle = await prisma.cycle.findFirst({ where: { orgId: ctx.orgId, projectId, status: "ACTIVE" } });
  }
  if (!cycle) return { error: "No active cycle found" };

  const items = await prisma.workItem.findMany({ where: { orgId: ctx.orgId, projectId, cycleId: cycle.id } });
  const totalPoints = items.reduce((s, i) => s + (i.storyPoints ?? 1), 0);
  const completedItems = items.filter((i) => i.completedAt);
  const completedPoints = completedItems.reduce((s, i) => s + (i.storyPoints ?? 1), 0);
  const blockedOrOverdue = items.filter((i) => !i.completedAt && i.dueDate && new Date(i.dueDate) < new Date());

  const now = new Date();
  const cycleStart = new Date(cycle.startDate);
  const cycleEnd = new Date(cycle.endDate);
  const totalDays = Math.max((cycleEnd.getTime() - cycleStart.getTime()) / 86400000, 1);
  const elapsed = Math.max((now.getTime() - cycleStart.getTime()) / 86400000, 0);
  const percentTimeElapsed = Math.round((elapsed / totalDays) * 100);
  const percentComplete = totalPoints > 0 ? Math.round((completedPoints / totalPoints) * 100) : 0;

  return {
    cycle: { id: cycle.id, name: cycle.name, number: cycle.number, goal: cycle.goal },
    dates: { start: cycle.startDate, end: cycle.endDate, percentTimeElapsed },
    progress: { totalItems: items.length, completedItems: completedItems.length, totalPoints, completedPoints, percentComplete },
    overdueItems: blockedOrOverdue.map((i) => ({ id: i.id, title: i.title, dueDate: i.dueDate })),
    onTrack: percentComplete >= percentTimeElapsed,
  };
}
