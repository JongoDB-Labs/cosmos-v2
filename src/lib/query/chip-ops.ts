/**
 * Editing one Basic-mode chip. `basic.ts` decides which queries ARE chips;
 * this is what a person can do to one: pick an operator, pick values, use a
 * date preset. Pure and client-safe, so the rules are tested without a DOM.
 *
 * A chip being edited is an `EditChip` ({field, op, values, text}), which may
 * be incomplete ("Assignee is any of …" with nothing picked yet).
 * `fromEdit` turns it back into a `Chip`, or null while it says nothing, so a
 * half-built chip never reaches the query (`IN ()` is not a query).
 *
 * Operator menus come from the same registry the typechecker uses (fields.ts,
 * CF_OPS), so Basic can never offer an operator Advanced would reject.
 */
import { sameField, type CqlNode, type CqlQuery, type CqlValue, type FieldRef } from "./ast";
import type { Chip } from "./basic";
import { lookupField, type OpFamily, type ValueKind } from "./fields";
import { parseCql } from "./parser";
import { printValue } from "./print";
import { CF_OPS, cfValueKind, type SchemaCustomField } from "./typecheck";

export type ChipOp =
  | "any"
  | "none"
  | "all"
  | "is"
  | "isNot"
  | "lt"
  | "gt"
  | "lte"
  | "gte"
  | "between"
  | "empty"
  | "notEmpty"
  | "contains"
  | "notContains";

export interface EditChip {
  field: FieldRef;
  op: ChipOp;
  values: CqlValue[];
  /** The `contains` text. */
  text: string;
  /**
   * How one value was written: `IN (x)` (true) or `= x` (false). Kept, so an
   * untouched chip prints as it was typed; unset for a chip built here.
   */
  list?: boolean;
}

export interface ChipField {
  field: FieldRef;
  label: string;
  value: ValueKind;
  ops: readonly OpFamily[];
  /** SELECT / MULTI_SELECT options, offered without a round trip. */
  options?: string[];
  /**
   * What the field means, in one line — the registry's own `description`. The
   * "Add filter" list showed labels alone, so `Ancestor` arrived with no hint
   * that it means "everything under this item, at any depth"; reported as "I saw
   * an ancestor filter, but I'm not really sure what that is".
   */
  hint?: string;
  /**
   * Everything a search over this field should match beyond its label: the
   * field id, its registry aliases, its enum values, and the hint. `Sprint`
   * answers to `interval` and `iteration`, and `Program increment` to `pi`,
   * because those are the words people actually type — and `Interval kind`
   * answers to `phase` because PHASE is one of its values.
   */
  terms?: string;
}

export const OP_LABELS: Record<ChipOp, string> = {
  any: "is any of",
  none: "is none of",
  all: "has all of",
  is: "is",
  isNot: "is not",
  lt: "before",
  gt: "after",
  lte: "on or before",
  gte: "on or after",
  between: "between",
  empty: "is empty",
  notEmpty: "is not empty",
  contains: "contains",
  notContains: "does not contain",
};

const NUMERIC_LABELS: Partial<Record<ChipOp, string>> = { lt: "<", gt: ">", lte: "≤", gte: "≥", is: "=", isNot: "≠" };

export function opLabel(op: ChipOp, kind: ValueKind): string {
  const numeric = kind.kind === "number" || kind.kind === "duration";
  return (numeric && NUMERIC_LABELS[op]) || OP_LABELS[op];
}

const isTemporal = (k: ValueKind) => k.kind === "date" || k.kind === "datetime";
const isOrdered = (k: ValueKind) => isTemporal(k) || k.kind === "number" || k.kind === "duration";

/**
 * The searchable text for a system field: its id and aliases first (those are
 * what people type), then any enum values, then the description. Joined into one
 * string because that is what <SearchableSelect>'s `searchText` matches.
 */
function fieldTerms(
  id: string,
  aliases: readonly string[],
  value: ValueKind,
  description?: string,
): string {
  const parts = [id, ...aliases];
  if (value.kind === "enum") parts.push(...value.values);
  if (description) parts.push(description);
  return parts.join(" ");
}

/** What a chip on `field` can be, or null when the field has no chip form. */
export function chipField(field: FieldRef, customFields: readonly SchemaCustomField[]): ChipField | null {
  if (field.kind === "sys") {
    const def = lookupField(field.id);
    if (!def || def.pending || def.ops.length === 0) return null;
    // History-only fields aside, every registry field has a chip.
    return {
      field,
      label: def.label,
      value: def.value,
      ops: def.ops,
      ...(def.description ? { hint: def.description } : {}),
      terms: fieldTerms(def.id, def.aliases, def.value, def.description),
    };
  }
  const cf = customFields.find((c) => c.key === field.key);
  if (!cf) return null;
  const value: ValueKind =
    (cf.fieldType === "SELECT" || cf.fieldType === "MULTI_SELECT") && cf.options?.length
      ? { kind: "enum", values: cf.options }
      : cfValueKind(cf.fieldType);
  // A custom field is written `cf[key]`, so the key is the term people type.
  return {
    field,
    label: cf.name,
    value,
    ops: CF_OPS[cf.fieldType],
    ...(cf.options ? { options: cf.options } : {}),
    terms: fieldTerms(cf.key, [], value),
  };
}

/** Every field a chip can be added for, system fields first. */
export function chipFields(customFields: readonly SchemaCustomField[], systemIds: readonly string[]): ChipField[] {
  const out: ChipField[] = [];
  for (const id of systemIds) {
    const f = chipField({ kind: "sys", id } as FieldRef, customFields);
    // The free-text box is the `text` field's editor; it is not offered twice.
    if (f && !(f.field.kind === "sys" && f.field.id === "text")) out.push(f);
  }
  for (const c of customFields) {
    const f = chipField({ kind: "cf", key: c.key }, customFields);
    if (f) out.push(f);
  }
  return out;
}

/** The operators a chip on `f` offers, in menu order. */
export function chipOps(f: ChipField): ChipOp[] {
  const has = (o: OpFamily) => f.ops.includes(o);
  const out: ChipOp[] = [];
  if (f.value.kind === "bool") return ["is"];
  if (has("in")) out.push("any", "none");
  if (has("inAll")) out.push("all");
  if (isOrdered(f.value)) {
    if (has("eq")) out.push("is");
    if (has("order")) out.push("lt", "gt", "between");
  } else if (has("eq") && !has("in")) out.push("is", "isNot");
  if (has("text")) out.push("contains", "notContains");
  if (has("empty")) out.push("empty", "notEmpty");
  return out;
}

/** The operator a fresh chip starts with. */
export function defaultOp(f: ChipField): ChipOp {
  return chipOps(f)[0] ?? "is";
}

export function newEdit(f: ChipField): EditChip {
  const op = defaultOp(f);
  return { field: f.field, op, values: f.value.kind === "bool" ? [{ t: "bool", v: true }] : [], text: "" };
}

/** A chip as an editable chip. Single-value `=` on a list field reads as "is any of". */
export function toEdit(c: Chip, f: ChipField | null): EditChip {
  const base = { field: c.field, values: [] as CqlValue[], text: "" };
  const listy = !!f && f.ops.includes("in") && f.value.kind !== "bool";
  switch (c.kind) {
    case "in":
      return { ...base, op: c.all ? "all" : c.negate ? "none" : "any", values: c.values, list: true };
    case "cmp":
      if (c.cmp === "eq") return { ...base, op: listy ? "any" : "is", values: [c.value], list: false };
      if (c.cmp === "neq") return { ...base, op: listy ? "none" : "isNot", values: [c.value], list: false };
      return { ...base, op: c.cmp, values: [c.value] };
    case "range":
      return { ...base, op: "between", values: [c.from, c.to] };
    case "empty":
      return { ...base, op: c.negate ? "notEmpty" : "empty" };
    case "text":
      return { ...base, op: c.negate ? "notContains" : "contains", text: c.query };
  }
}

const scalar = (v: CqlValue) => v.t !== "empty" && v.t !== "var" && (v.t !== "fn" || v.name === "currentUser");

/** Back to a chip, or null while it is incomplete. */
export function fromEdit(e: EditChip): Chip | null {
  const [a, b] = e.values;
  switch (e.op) {
    case "any":
    case "none":
      if (!e.values.length) return null;
      // One value reads better as `=` / `!=` — unless it is a set (`IN $team`,
      // `IN openSprints()`) or was written as a list.
      if (e.values.length === 1 && (e.list === false || (e.list === undefined && scalar(a)))) return { kind: "cmp", field: e.field, cmp: e.op === "any" ? "eq" : "neq", value: a };
      return { kind: "in", field: e.field, ...(e.op === "none" ? { negate: true } : {}), values: e.values };
    case "all":
      return e.values.length ? { kind: "in", field: e.field, all: true, values: e.values } : null;
    case "is":
    case "isNot":
      return a ? { kind: "cmp", field: e.field, cmp: e.op === "is" ? "eq" : "neq", value: a } : null;
    case "lt":
    case "gt":
    case "lte":
    case "gte":
      return a ? { kind: "cmp", field: e.field, cmp: e.op, value: a } : null;
    case "between":
      return a && b ? { kind: "range", field: e.field, from: a, to: b } : null;
    case "empty":
    case "notEmpty":
      return { kind: "empty", field: e.field, ...(e.op === "notEmpty" ? { negate: true } : {}) };
    case "contains":
    case "notContains":
      // Not trimmed: `~ "log "` (a word boundary) is a different query from `~ "log"`.
      return e.text ? { kind: "text", field: e.field, ...(e.op === "notContains" ? { negate: true } : {}), query: e.text } : null;
  }
}

/** Change the operator, keeping whatever values still make sense. */
export function withOp(e: EditChip, op: ChipOp): EditChip {
  const many = (o: ChipOp) => o === "any" || o === "none" || o === "all";
  const values =
    op === "empty" || op === "notEmpty" || op === "contains" || op === "notContains"
      ? []
      : many(op) && many(e.op)
        ? e.values
        : op === "between"
          ? e.values.slice(0, 2)
          : e.values.slice(0, 1);
  return { ...e, op, values };
}

// ── date presets (DUE_PRESETS' vocabulary) ───────────────────────────────────

export type DatePreset = "overdue" | "thisWeek" | "thisMonth" | "last7" | "last30" | "none";

export const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "thisWeek", label: "This week" },
  { id: "thisMonth", label: "This month" },
  { id: "last7", label: "Last 7 days" },
  { id: "last30", label: "Last 30 days" },
  { id: "none", label: "No date" },
];

const fn = (name: "now" | "startOfWeek" | "endOfWeek" | "startOfMonth" | "endOfMonth"): CqlValue => ({ t: "fn", name, args: [] });

/** The presets a field offers: "Overdue" only for future-facing dates, "No date" only when it can be empty. */
export function datePresets(f: ChipField): typeof DATE_PRESETS {
  if (!isTemporal(f.value) || !f.ops.includes("order")) return [];
  const id = f.field.kind === "sys" ? f.field.id : "";
  // Plans look forward; history ("created", "updated") only looks back.
  const plan = id === "due" || id === "start";
  return DATE_PRESETS.filter((p) =>
    p.id === "overdue" ? id === "due" : p.id === "none" ? f.ops.includes("empty") : p.id === "last7" || p.id === "last30" ? !plan : true,
  );
}

export function presetEdit(field: FieldRef, p: DatePreset): EditChip {
  const base = { field, text: "" };
  switch (p) {
    case "overdue":
      return { ...base, op: "lt", values: [fn("now")] };
    case "thisWeek":
      return { ...base, op: "between", values: [fn("startOfWeek"), fn("endOfWeek")] };
    case "thisMonth":
      return { ...base, op: "between", values: [fn("startOfMonth"), fn("endOfMonth")] };
    case "last7":
      return { ...base, op: "gte", values: [{ t: "rel", v: "-7d" }] };
    case "last30":
      return { ...base, op: "gte", values: [{ t: "rel", v: "-30d" }] };
    case "none":
      return { ...base, op: "empty", values: [] };
  }
}

/** Which preset an edit is, if any — so the chip can say "Due: Overdue". */
export function presetOf(e: EditChip): DatePreset | null {
  for (const p of DATE_PRESETS) {
    const x = presetEdit(e.field, p.id);
    if (x.op === e.op && x.values.length === e.values.length && x.values.every((v, i) => printValue(v) === printValue(e.values[i]))) {
      return p.id;
    }
  }
  return null;
}

// ── values ───────────────────────────────────────────────────────────────────

/** A value as a person reads it: names unquoted, `me`, `startOfWeek()`. */
export function valueLabel(v: CqlValue): string {
  return v.t === "str" ? v.v : printValue(v);
}

/** The text that reads back as `v`; the identity used to match picker options. */
export function valueKey(v: CqlValue): string {
  return printValue(v);
}

/**
 * A suggestion's `insert` text as a value (`me`, `"Dana Ruiz"`, `HIGH`,
 * `2026-01-31`, `-7d`), or null when it isn't one.
 */
export function parseValueText(text: string): CqlValue | null {
  const t = text.trim();
  if (!t) return null;
  // Inside a list, so `EMPTY` reads as a value too.
  const { query, diagnostics } = parseCql(`key IN (${t})`);
  const w = query.where;
  if (diagnostics.length || w?.op !== "in" || w.values.length !== 1) return null;
  return w.values[0];
}

// ── whole-query toggles (Watching, Archived) ─────────────────────────────────

/** The top-level clauses of an AND (or the lone clause). */
function topClauses(q: CqlQuery): CqlNode[] | null {
  if (!q.where) return [];
  if (q.where.op === "and") return q.where.args;
  if (q.where.op === "or") return null;
  return [q.where];
}

const same = (a: CqlNode, b: CqlNode) =>
  a.op === "cmp" && b.op === "cmp" && sameField(a.field, b.field) && a.cmp === b.cmp && printValue(a.value) === printValue(b.value);

/** Is `clause` one of the query's top-level AND clauses? */
export function hasClause(q: CqlQuery, clause: CqlNode): boolean {
  return (topClauses(q) ?? []).some((n) => same(n, clause));
}

/** Add or remove a top-level AND clause. An OR at the top is kept whole and ANDed. */
export function toggleClause(q: CqlQuery, clause: CqlNode): CqlQuery {
  const parts = topClauses(q);
  if (parts && parts.some((n) => same(n, clause))) {
    const rest = parts.filter((n) => !same(n, clause));
    return { ...q, where: rest.length === 0 ? null : rest.length === 1 ? rest[0] : { op: "and", args: rest } };
  }
  const base = parts ?? [q.where!];
  const args = [...base, clause];
  return { ...q, where: args.length === 1 ? args[0] : { op: "and", args } };
}

export const WATCHING: CqlNode = {
  op: "cmp",
  field: { kind: "sys", id: "watcher" },
  cmp: "eq",
  value: { t: "fn", name: "currentUser", args: [] },
};

export const ARCHIVED_ONLY: CqlNode = {
  op: "cmp",
  field: { kind: "sys", id: "archived" },
  cmp: "eq",
  value: { t: "bool", v: true },
};

/**
 * The legacy filter's free text (`summary ~ t OR description ~ t`) as the
 * Issues box writes it, `text ~ t`, so a converted query stays chips. Leaves
 * everything else alone.
 */
export function simplifyLegacyText(q: CqlQuery): CqlQuery {
  const fix = (n: CqlNode): CqlNode =>
    n.op === "or"
    && n.args.length === 2
    && n.args.every((a) => a.op === "text" && !a.negate && a.field.kind === "sys" && (a.field.id === "summary" || a.field.id === "description"))
    && (n.args[0] as { query: string }).query === (n.args[1] as { query: string }).query
      ? { op: "text", field: { kind: "sys", id: "text" }, query: (n.args[0] as { query: string }).query }
      : n;
  if (!q.where) return q;
  return { ...q, where: q.where.op === "and" ? { op: "and", args: q.where.args.map(fix) } : fix(q.where) };
}

/**
 * The reverse, for storing in the legacy shape: the box's `text ~ t` as
 * `summary ~ t OR description ~ t`. Transitional and slightly narrower (the
 * legacy filter never searched comments); saved filters v2 store CQL itself.
 */
export function legacyText(q: CqlQuery): CqlQuery {
  const fix = (n: CqlNode): CqlNode =>
    n.op === "text" && !n.negate && n.field.kind === "sys" && n.field.id === "text"
      ? {
          op: "or",
          args: [
            { op: "text", field: { kind: "sys", id: "summary" }, query: n.query },
            { op: "text", field: { kind: "sys", id: "description" }, query: n.query },
          ],
        }
      : n;
  if (!q.where) return q;
  return { ...q, where: q.where.op === "and" ? { op: "and", args: q.where.args.map(fix) } : fix(q.where) };
}
