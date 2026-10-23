/**
 * CQL described in words, for whoever writes queries without the editor: the
 * assistant's `search_work_items` / `describe_cql` tools and the "Ask AI to
 * build a filter" box (query design §12.3).
 *
 * Generated from the same registries the parser and typechecker read, so the
 * reference can't describe a field or function the language doesn't have. It
 * holds the SCHEMA only (field names, operators, enum spellings, function
 * names): no item, person or project from any org.
 *
 * Pure and client-safe.
 */
import { FIELDS, type FieldDef, type OpFamily, type ValueKind } from "./fields";
import { FUNCTIONS } from "./functions";
import type { SchemaCustomField } from "./typecheck";

/** The syntax help's examples; a test parses and typechecks every one. */
export const CQL_EXAMPLES: { q: string; says: string }[] = [
  { q: "assignee = me AND statusCategory != DONE ORDER BY priority, due", says: "My open work, most urgent first" },
  { q: "priority IN (HIGH, CRITICAL) AND due < now()", says: "Urgent and overdue" },
  { q: "sprint IN openSprints() AND assignee IS EMPTY", says: "Unassigned in the current sprint" },
  { q: "assignee IN membersOf(\"Platform\") AND updated >= -3wd", says: "The Platform team's work touched in the last 3 working days" },
  { q: 'text ~ "login" AND type = Bug', says: "Bugs that mention login (title, description or comments)" },
  { q: "labels IN ALL (auth, security)", says: "Has both labels" },
  { q: 'status CHANGED FROM Review TO "In Progress" AFTER -14d', says: "Sent back from review in the last two weeks" },
  { q: "status WAS Done AND statusCategory != DONE", says: "Reopened after being done" },
  { q: "assignee WAS me AND assignee != me", says: "Handed off by me (or to someone else)" },
  { q: "priority CHANGED BY me DURING (startOfWeek(), now())", says: "Priorities I changed this week" },
];

const OPS: Record<OpFamily, string> = {
  eq: "= !=",
  in: "IN NOT IN",
  inAll: "IN ALL",
  order: "< <= > >=",
  empty: "IS EMPTY",
  text: "~ !~",
  history: "WAS CHANGED",
};

function valueText(v: ValueKind): string {
  switch (v.kind) {
    case "ref":
      return v.entity === "item" ? "ticket key" : v.entity;
    case "enum":
      return v.values.join("|");
    case "bool":
      return "true|false";
    default:
      return v.kind;
  }
}

/** One line per field: `name (value; operators): description`. */
export function describeField(f: FieldDef): string {
  const ops = f.ops.map((o) => OPS[o]).join(" ");
  const aliases = f.aliases.length ? ` aka ${f.aliases.join(", ")}` : "";
  const how = ops ? `${valueText(f.value)}; ${ops}` : `${valueText(f.value)}; ORDER BY only`;
  return `${f.id}${aliases} (${how}): ${f.description}`;
}

/** The field names only, for a tool description that must stay short. */
export function fieldNames(): string {
  return FIELDS.filter((f) => !f.pending).map((f) => f.id).join(", ");
}

const SYNTAX = [
  "CQL (Cosmos Query Language) is like Jira's JQL.",
  "A query is `field operator value` clauses joined with AND / OR / NOT and grouped with parentheses, then an optional `ORDER BY field [ASC|DESC], ...`. `ORDER BY priority` puts CRITICAL first.",
  "Operators: = != < <= > >=, IN (a, b) and NOT IN (a, b), IN ALL (a, b) for labels, IS EMPTY / IS NOT EMPTY, ~ and !~ (contains, case-insensitive; a trailing * is a prefix).",
  "History: `field WAS value`, WAS NOT, WAS IN (a, b), and `field CHANGED`, each optionally with FROM x, TO y, BY user, AFTER date, BEFORE date, ON date or DURING (date, date).",
  "Values with spaces or punctuation are quoted: \"In Review\". `me` is the current user. Ticket keys are written bare: ACME-12.",
  "Dates: 2026-01-31, or relative to now: -7d, 2w, -1M (months; m is minutes), -3wd (working days); or a function such as startOfWeek().",
  "Custom fields are named by key, or as cf[\"Field name\"] when the name has spaces.",
];

/**
 * The whole reference: syntax, every queryable field, every function, the
 * org's custom fields (names and option spellings: schema, not data), and the
 * examples.
 */
export function cqlReference(customFields: readonly SchemaCustomField[] = []): string {
  const lines = [...SYNTAX, "", "Fields:"];
  for (const f of FIELDS) if (!f.pending) lines.push(`- ${describeField(f)}`);
  lines.push("", "Functions:");
  for (const fn of FUNCTIONS) {
    if (fn.pending) continue;
    const args = fn.args.map((a) => (a.optional ? `${a.kind}?` : a.kind)).join(", ");
    lines.push(`- ${fn.name}(${args})${fn.many ? " [a set: use with IN]" : ""}: ${fn.description}`);
  }
  if (customFields.length) {
    lines.push("", "Custom fields:");
    for (const cf of customFields) {
      const options = cf.options?.length ? `; options ${cf.options.join("|")}` : "";
      lines.push(`- ${cf.key} ("${cf.name}", ${cf.fieldType.toLowerCase()}${options})`);
    }
  }
  lines.push("", "Examples:");
  for (const e of CQL_EXAMPLES) lines.push(`- ${e.q}  -- ${e.says}`);
  return lines.join("\n");
}

/**
 * The query in a model's reply: the first fenced block if there is one, else
 * the first non-empty line, without a "CQL:" label or wrapping backticks.
 */
export function cqlFromReply(raw: string): string {
  const fenced = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/.exec(raw);
  const body = (fenced ? fenced[1] : raw).trim();
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.replace(/^(?:cql|query)\s*:\s*/i, "").replace(/^`+|`+$/g, "").trim();
}
