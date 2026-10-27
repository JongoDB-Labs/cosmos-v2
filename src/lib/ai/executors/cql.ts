import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { executeCql } from "@/lib/query/execute.server";
import { suggestValues } from "@/lib/query/suggest.server";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { loadSchemaCustomFields } from "@/lib/query/resolve.server";
import { cqlEnabled } from "@/lib/query/flag";
import { CqlError, type CqlDiagnostic } from "@/lib/query/errors";
import { CQL_LIMITS } from "@/lib/query/ast";
import { lookupField } from "@/lib/query/fields";
import { cqlReference, describeField, fieldNames } from "@/lib/query/describe";
import type { IssueRow } from "@/lib/work-items/query/project";
import { SEARCH_FIELDS } from "../tools/cql";
import { assertPermission, loadAuthContext, type ToolContext } from "./_ctx";

/**
 * The assistant on the query language (query design §12.3): one search across
 * every project the caller can read, through the SAME `executeCql` the Issues
 * list runs, so the assistant can never see an item, or a count, the user
 * couldn't. `executeCql` reads the caller's readable projects itself; nothing
 * here narrows or widens that.
 *
 * Results reach the model through the egress gate like every tool's (§6.6).
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

/** The org's slug, or an error when the query language is off for it. */
async function cqlOrg(ctx: ToolContext): Promise<{ slug: string } | { error: string }> {
  const org = await prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { slug: true, settings: true } });
  if (!org || !cqlEnabled(org.settings)) {
    return { error: "The query language is not switched on for this organization. Use list_work_items instead." };
  }
  return { slug: org.slug };
}

/** What the model needs to fix a query: the message, where, and any suggested fix. */
function diagnosticsForModel(diagnostics: CqlDiagnostic[]) {
  return diagnostics.map((d) => ({
    severity: d.severity,
    message: d.message,
    line: d.line,
    column: d.column,
    ...(d.hint ? { hint: d.hint } : {}),
    ...(d.fixes?.length ? { fixes: d.fixes.map((f) => f.label) } : {}),
  }));
}

type SearchField = (typeof SEARCH_FIELDS)[number];

/**
 * A row flattened for the model. Ids and dates are always there (the
 * structural projection a GOV tenant sees keeps exactly those); `fields`
 * picks the rest.
 */
function itemForModel(r: IssueRow, fields: ReadonlySet<SearchField>) {
  return {
    id: r.id,
    ticketNumber: r.ticketNumber,
    ticketKey: r.ticketKey,
    projectId: r.project.id,
    workItemTypeId: r.type.id,
    type: r.type.name,
    parentId: r.parent?.id ?? null,
    startDate: r.startDate,
    completedAt: r.completedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(fields.has("title") ? { title: r.title } : {}),
    // The column key is free text a team chose, so it is `columnKey`, never
    // the allowlisted `status`: the GOV projection drops it, as for list_work_items.
    ...(fields.has("status") ? { columnKey: r.columnKey } : {}),
    ...(fields.has("assignee") ? { assigneeId: r.assignee?.id ?? null, assigneeName: r.assignee?.displayName ?? null } : {}),
    // `reporterName` resolves from the User table, so a former member is still
    // named here — "tickets created by <person who left>" is the workflow this
    // field exists for. Like `assigneeName` it is PII and stays OUT of
    // EXPOSABLE_FIELDS, so a withheld (gov) result drops it by default-deny.
    ...(fields.has("reporter") ? { reporterId: r.reporter?.id ?? null, reporterName: r.reporter?.displayName ?? null } : {}),
    ...(fields.has("priority") ? { priority: r.priority } : {}),
    ...(fields.has("due") ? { dueDate: r.dueDate } : {}),
    ...(fields.has("sprint") ? { intervalId: r.intervalId } : {}),
    ...(fields.has("points") ? { storyPoints: r.storyPoints } : {}),
    ...(fields.has("labels") ? { labels: r.tags } : {}),
  };
}

// ── search_work_items ───────────────────────────────────────────────────────
const searchSchema = z.object({
  cql: z.string().trim().min(1, "cql is required").max(CQL_LIMITS.textLength),
  limit: z.number().int().positive().max(50).optional(),
  fields: z.array(z.enum(SEARCH_FIELDS)).optional(),
});

export async function searchWorkItems(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  const org = await cqlOrg(ctx);
  if ("error" in org) return org;

  const { cql, limit, fields } = parsed.data;
  try {
    const result = await executeCql(auth, { cql }, { pageSize: limit ?? 25 });
    const pick = new Set<SearchField>(fields?.length ? fields : SEARCH_FIELDS);
    return {
      count: result.data.length,
      // null when counting ran out of time: "more than can be counted quickly".
      total: result.total,
      totalCapped: result.totalCapped,
      cql: result.cql,
      url: `/${org.slug}/issues?cql=${encodeURIComponent(result.cql)}`,
      items: result.data.map((r) => itemForModel(r, pick)),
      ...(result.diagnostics.length ? { warnings: diagnosticsForModel(result.diagnostics) } : {}),
    };
  } catch (e) {
    if (e instanceof CqlError) {
      return { error: `${e.message} Fix the query and try again.`, diagnostics: diagnosticsForModel(e.diagnostics) };
    }
    throw e;
  }
}

// ── describe_cql ────────────────────────────────────────────────────────────
const describeSchema = z.object({
  field: z.string().trim().min(1).max(100).optional(),
  prefix: z.string().max(100).optional(),
});

export async function describeCql(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;
  const parsed = describeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  const org = await cqlOrg(ctx);
  if ("error" in org) return org;

  const readable = await getReadableProjectIds(auth);
  const customFields = await loadSchemaCustomFields(ctx.orgId, readable);
  const { field, prefix } = parsed.data;
  if (!field) return { reference: cqlReference(customFields) };

  const def = lookupField(field);
  const cf = def ? undefined : customFields.find((c) => c.key.toLowerCase() === field.toLowerCase() || c.name.toLowerCase() === field.toLowerCase());
  if (!def && !cf) return { error: `Unknown field "${field}". Fields: ${fieldNames()}, or a custom field's key.` };

  // Values exactly as the editor suggests them: scoped like the resolver, and
  // each `value` is the text that reads back as that value in a query.
  const values = await suggestValues(auth, { field, prefix: prefix ?? "", limit: 50 });
  return {
    field: def ? describeField(def) : `${cf!.key} ("${cf!.name}", custom ${cf!.fieldType.toLowerCase()})`,
    count: values.length,
    values: values.map((v) => ({ value: v.insert, label: v.label, ...(v.detail ? { detail: v.detail } : {}) })),
  };
}
