/**
 * ⌘K's attribute match: a work item whose LABEL name or CUSTOM-FIELD value
 * contains the search text, so an item can be found by what it carries and
 * not only by its title or number.
 *
 * NOT a second matcher. The clauses are a CQL query — `label IN (…)`,
 * `cf[k] ~ "text"`, `cf[k] IN (…)` — run through the CQL executor's own
 * pipeline (typecheck, resolve, compile) and placed inside its scope envelope
 * (`scopedWhereCql`). So a value matches here exactly as it would on the
 * Issues page, and this branch can only admit items the caller may read
 * there: projects they can read items in, team scoping, ABAC denies and an API
 * key's `projectScope` included. A field defined on a project the caller
 * can't read is not in their CQL schema, so it isn't searched either.
 *
 * Which fields: free text (TEXT, URL, EMAIL) by contains, and SELECT /
 * MULTI_SELECT by any option whose text contains the search. Numbers, dates,
 * checkboxes and people are left out on purpose: "3" would match every item
 * with three story points, and a person is found under People.
 *
 * When it doesn't run: for fewer than ATTRIBUTE_MIN_LENGTH characters (it runs
 * on every keystroke the palette sends, and a short needle matches nearly
 * everything), and in an org that has switched CQL off, since this is a CQL
 * query; the search then matches titles and numbers only, as it did before.
 * A free-text field is left out for text CQL can't search with `~` (a `*`
 * anywhere but the end); labels and choices are still matched.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { CQL_LIMITS, CQL_VERSION, type CqlNode, type CqlQuery } from "@/lib/query/ast";
import { loadSchemaCustomFields } from "@/lib/query/resolve.server";
import { scopedWhereCql } from "@/lib/query/execute.server";
import { likeText } from "@/lib/query/like";
import { cqlEnabled } from "@/lib/query/flag";
import type { SchemaCustomField } from "@/lib/query/typecheck";

const TEXT_TYPES = new Set(["TEXT", "URL", "EMAIL"]);
const CHOICE_TYPES = new Set(["SELECT", "MULTI_SELECT"]);
/** The longest value quoted back as the reason for a match. */
const REASON_MAX = 80;
/** Shorter search text matches names only. */
export const ATTRIBUTE_MIN_LENGTH = 3;
/**
 * The statement budget for each step of the branch, in ms: CQL's own
 * resolution here, and the search's query (registry.server.ts). The palette
 * sends a search per pause in typing; past this, it answers with names only.
 */
export const ATTRIBUTE_BUDGET_MS = 1_500;

export interface AttributeMatch {
  /** Items with a matching label or field value, inside the CQL scope envelope. */
  where: Prisma.WorkItemWhereInput;
  /** What each of `ids` matched on, e.g. "Label: Security"; ids that matched nothing here are absent. */
  describe(ids: string[]): Promise<Map<string, string>>;
}

/** The search text as CQL's `~` reads it: a trailing `*` means "starts with". */
const needle = (q: string) => q.replace(/\*$/, "").toLowerCase();

/** Text CQL's `~` accepts: no `*`, or one at the end (typecheck refuses any other). */
const searchableByTilde = (q: string) => !q.includes("*") || /^[^*]+\*$/.test(q.trim());

/**
 * The attribute clauses for `q`, as a CQL query, or null when nothing in the
 * org could match (no label, no searchable field). Pure, so the clause shape
 * is testable without a database.
 */
export function attributeQuery(
  q: string,
  labels: ReadonlyArray<{ id: string; name: string }>,
  fields: readonly SchemaCustomField[],
): CqlQuery | null {
  const n = needle(q);
  const clauses: CqlNode[] = [];
  if (labels.length) {
    clauses.push({
      op: "in",
      field: { kind: "sys", id: "label" },
      values: labels.slice(0, CQL_LIMITS.inValues).map((l) => ({ t: "ref", entity: "label", id: l.id, label: l.name })),
    });
  }
  const tilde = searchableByTilde(q);
  for (const f of fields) {
    if (clauses.length >= CQL_LIMITS.clauses) break;
    if (TEXT_TYPES.has(f.fieldType)) {
      // Refused by typecheck, it would fail the whole query and lose the labels too.
      if (tilde) clauses.push({ op: "text", field: { kind: "cf", key: f.key }, query: q });
    } else if (CHOICE_TYPES.has(f.fieldType)) {
      const options = (f.options ?? []).filter((o) => o.toLowerCase().includes(n)).slice(0, CQL_LIMITS.inValues);
      if (options.length) clauses.push({ op: "in", field: { kind: "cf", key: f.key }, values: options.map((v) => ({ t: "str", v })) });
    }
  }
  if (clauses.length === 0) return null;
  return { v: CQL_VERSION, where: clauses.length === 1 ? clauses[0] : { op: "or", args: clauses } };
}

/** The first label or field of `row` that contains the search, as a reason. Display only. */
export function matchReason(
  q: string,
  row: { customFields: unknown; labels: ReadonlyArray<{ name: string }> },
  fields: readonly SchemaCustomField[],
): string | undefined {
  const n = needle(q);
  if (!n) return undefined;
  const label = row.labels.map((l) => l.name).filter((name) => name.toLowerCase().includes(n)).sort()[0];
  if (label) return `Label: ${label}`;
  const values = (row.customFields ?? {}) as Record<string, unknown>;
  for (const f of fields) {
    if (!TEXT_TYPES.has(f.fieldType) && !CHOICE_TYPES.has(f.fieldType)) continue;
    const v = values[f.key];
    const hit = (Array.isArray(v) ? v : [v]).find((x): x is string => typeof x === "string" && x.toLowerCase().includes(n));
    if (hit) return `${f.name}: ${hit.length > REASON_MAX ? `${hit.slice(0, REASON_MAX - 1)}…` : hit}`;
  }
  return undefined;
}

/**
 * The attribute branch of a work-item search for `q`, or null when it can
 * match nothing for this caller (nothing readable, or no label or field that
 * could match).
 */
export async function itemAttributeMatch(ctx: AuthContext, q: string): Promise<AttributeMatch | null> {
  const text = q.trim();
  if (needle(text).length < ATTRIBUTE_MIN_LENGTH) return null;
  // Off, the org has no query language, so this branch doesn't exist for it.
  const org = await prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { settings: true } });
  if (!org || !cqlEnabled(org.settings)) return null;
  const readable = await getReadableProjectIds(ctx);
  if (readable.length === 0) return null;
  const [labels, fields] = await Promise.all([
    // Labels are the org's shared vocabulary (no project), as the label picker lists them.
    // LIKE's own wildcards escaped, as CQL's `~` does: "%" is text, not "anything".
    prisma.label.findMany({
      where: { orgId: ctx.orgId, name: { contains: likeText(text), mode: "insensitive" } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: CQL_LIMITS.inValues,
    }),
    // Org-wide fields plus those of readable projects: the caller's CQL schema.
    loadSchemaCustomFields(ctx.orgId, readable),
  ]);
  const query = attributeQuery(text, labels, fields);
  if (!query) return null;
  const where = await scopedWhereCql(ctx, { query }, { timeoutMs: ATTRIBUTE_BUDGET_MS });
  if (!where) return null;
  return {
    where,
    async describe(ids) {
      const out = new Map<string, string>();
      if (ids.length === 0) return out;
      const rows = await prisma.workItem.findMany({
        where: { orgId: ctx.orgId, id: { in: ids } },
        select: { id: true, customFields: true, labels: { select: { label: { select: { name: true, orgId: true } } } } },
      });
      for (const r of rows) {
        const reason = matchReason(
          text,
          { customFields: r.customFields, labels: r.labels.filter((l) => l.label.orgId === ctx.orgId).map((l) => l.label) },
          fields,
        );
        if (reason) out.set(r.id, reason);
      }
      return out;
    },
  };
}
