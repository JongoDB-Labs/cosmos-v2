/**
 * The CQL typechecker: does each clause make sense for its field?
 *
 * Runs on the client on every keystroke (with the field schema from
 * GET /cql/schema) and again on the server. It needs no values from the
 * database, so it never discloses anything; unknown VALUES are the resolver's
 * job.
 *
 * Besides diagnosing, it canonicalises what it can without data: a custom
 * field named by its display name becomes its key, enum values take their
 * canonical spelling (`todo` → TODO), and `sprint = openSprints()` is accepted
 * as the IN it obviously means.
 */
import {
  CQL_VERSION,
  REL_RE,
  type CqlNode,
  type CqlQuery,
  type CqlSort,
  type CqlValue,
  type FieldRef,
  type LeafNode,
} from "./ast";
import {
  FIELDS,
  JQL_UNMAPPED,
  LINK_TYPES,
  fieldDef,
  isHistoryField,
  type FieldDef,
  type OpFamily,
  type ValueKind,
} from "./fields";
import { FUNCTIONS, lookupFunction, type FunctionDef } from "./functions";
import { diag, suggest, type CqlDiagnostic, type Span } from "./errors";
import { printField } from "./print";

export type CustomFieldType =
  | "TEXT"
  | "NUMBER"
  | "DATE"
  | "SELECT"
  | "MULTI_SELECT"
  | "CHECKBOX"
  | "URL"
  | "EMAIL"
  | "USER";

export interface SchemaCustomField {
  key: string;
  name: string;
  fieldType: CustomFieldType;
  options?: string[];
}

/** What the typechecker knows about the org. Shipped to the client by /cql/schema. */
export interface CqlSchema {
  customFields: SchemaCustomField[];
}

export interface TypecheckResult {
  query: CqlQuery;
  diagnostics: CqlDiagnostic[];
}

/** Statuses' category spellings people actually type. */
const CATEGORY_ALIASES: Record<string, string> = {
  todo: "TODO",
  "to do": "TODO",
  to_do: "TODO",
  open: "TODO",
  inprogress: "IN_PROGRESS",
  "in progress": "IN_PROGRESS",
  "in-progress": "IN_PROGRESS",
  in_progress: "IN_PROGRESS",
  doing: "IN_PROGRESS",
  done: "DONE",
  closed: "DONE",
  complete: "DONE",
  completed: "DONE",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
};

/** Fields where `!=` / NOT IN silently also hides "no value" (the Jira gotcha). */
const NULLABLE = new Set([
  "assignee", "watcher", "label", "sprint", "team", "parent", "milestone", "points",
  "originalEstimate", "remainingEstimate", "timeSpent", "due", "start", "actualStart",
  "completed", "archivedAt", "cancelReason", "resolution", "highlight", "externalKey",
  "externalSource",
]);

const CF_OPS: Record<CustomFieldType, readonly OpFamily[]> = {
  TEXT: ["eq", "empty"],
  URL: ["eq", "empty"],
  EMAIL: ["eq", "empty"],
  NUMBER: ["eq", "order", "empty"],
  DATE: ["eq", "order", "empty"],
  SELECT: ["eq", "in", "empty"],
  MULTI_SELECT: ["eq", "in", "inAll", "empty"],
  CHECKBOX: ["eq"],
  USER: ["eq", "in", "empty"],
};

function cfValueKind(t: CustomFieldType): ValueKind {
  switch (t) {
    case "NUMBER":
      return { kind: "number" };
    case "DATE":
      return { kind: "date" };
    case "CHECKBOX":
      return { kind: "bool" };
    case "USER":
      return { kind: "ref", entity: "user" };
    default:
      return { kind: "string" };
  }
}

function familyOf(n: LeafNode): OpFamily {
  switch (n.op) {
    case "cmp":
      return n.cmp === "eq" || n.cmp === "neq" ? "eq" : "order";
    case "in":
      return n.all ? "inAll" : "in";
    case "empty":
      return "empty";
    case "text":
      return "text";
    default:
      return "history";
  }
}

const OP_TEXT: Record<OpFamily, string> = {
  eq: "`=` / `!=`",
  in: "`IN`",
  inAll: "`IN ALL`",
  order: "`<` / `>`",
  empty: "`IS EMPTY`",
  text: "`~`",
  history: "`WAS` / `CHANGED`",
};

function opAdvice(ops: readonly OpFamily[]): string {
  return ops.length ? `use ${ops.map((o) => OP_TEXT[o]).join(", ")}` : "it can only be used in ORDER BY";
}

const HISTORY_FIELDS = FIELDS.filter((f) => f.ops.includes("history")).map((f) => f.id);

function fnReturnsFor(kind: ValueKind): FunctionDef["returns"][] {
  switch (kind.kind) {
    case "ref":
      return kind.entity === "user"
        ? ["user"]
        : kind.entity === "interval"
          ? ["interval"]
          : kind.entity === "team"
            ? ["team"]
            : kind.entity === "project"
              ? ["project"]
              : kind.entity === "item"
                ? ["item"]
                : [];
    case "date":
    case "datetime":
      return ["datetime"];
    default:
      return [];
  }
}

export function typecheck(input: CqlQuery, schema: CqlSchema, text = "", spans?: WeakMap<object, Span>): TypecheckResult {
  const diagnostics: CqlDiagnostic[] = [];
  const at = (o: object | undefined) => (o && spans?.get(o)) || { from: 0, to: 0 };
  const err = (code: Parameters<typeof diag>[1], message: string, o?: object, hint?: string) =>
    diagnostics.push(diag(text, code, message, at(o), hint ? { hint } : {}));

  const cfByKey = new Map(schema.customFields.map((c) => [c.key.toLowerCase(), c]));
  const cfByName = new Map(schema.customFields.map((c) => [c.name.toLowerCase(), c]));

  /** A field resolved to its definition, or null after reporting why not. */
  function resolveField(f: FieldRef): { ref: FieldRef; def?: FieldDef; cf?: SchemaCustomField } | null {
    if (f.kind === "sys") {
      const def = fieldDef(f.id);
      if (def.pending) {
        err("CQL_NOT_YET_SUPPORTED", `\`${def.id}\` arrives with ${def.pending}.`, f);
        return null;
      }
      return { ref: f, def };
    }
    const cf = cfByKey.get(f.key.toLowerCase()) ?? cfByName.get(f.key.toLowerCase());
    if (cf) {
      const ref: FieldRef = { kind: "cf", key: cf.key };
      spans?.set(ref, at(f));
      return { ref, cf };
    }
    const unmapped = JQL_UNMAPPED[f.key.toLowerCase()];
    if (unmapped) {
      err("CQL_UNKNOWN_FIELD", `\`${f.key}\` is a Jira field. ${unmapped}`, f);
      return null;
    }
    const candidates = [...FIELDS.map((d) => d.id), ...schema.customFields.map((c) => c.name)];
    const near = suggest(f.key, candidates);
    err(
      "CQL_UNKNOWN_FIELD",
      `Unknown field \`${f.key}\`.`,
      f,
      near.length ? `Did you mean ${near.map((n) => `\`${n}\``).join(" or ")}?` : undefined,
    );
    return null;
  }

  function checkFunction(v: Extract<CqlValue, { t: "fn" }>, kind: ValueKind, inList: boolean): CqlValue | null {
    const def = lookupFunction(v.name);
    if (!def) {
      const near = suggest(v.name, FUNCTIONS.map((f) => f.name));
      err(
        "CQL_UNKNOWN_FUNCTION",
        `Unknown function \`${v.name}()\`.`,
        v,
        near.length ? `Did you mean ${near.map((n) => `\`${n}()\``).join(" or ")}?` : undefined,
      );
      return null;
    }
    if (def.pending) {
      err("CQL_NOT_YET_SUPPORTED", `\`${def.name}()\` arrives with ${def.pending}.`, v);
      return null;
    }
    const required = def.args.filter((a) => !a.optional).length;
    if (v.args.length < required || v.args.length > def.args.length) {
      err("CQL_TYPE_MISMATCH", `\`${def.name}()\` takes ${required === def.args.length ? required : `${required} to ${def.args.length}`} argument(s).`, v);
      return null;
    }
    v.args.forEach((a, i) => {
      const spec = def.args[i];
      if (spec.kind === "rel" && a.t !== "rel" && a.t !== "num") err("CQL_TYPE_MISMATCH", `\`${def.name}()\` takes an offset like \`-1w\` or \`-1\`.`, a);
      if (spec.kind === "linkType" && !(a.t === "str" && (LINK_TYPES as readonly string[]).includes(a.v.toUpperCase()))) {
        err("CQL_TYPE_MISMATCH", `Link type must be one of ${LINK_TYPES.join(", ")}.`, a);
      }
      if (spec.kind === "date" && !(a.t === "date" || a.t === "rel" || a.t === "fn" || a.t === "var")) {
        err("CQL_TYPE_MISMATCH", `\`${def.name}()\` takes dates here.`, a);
      }
      if ((spec.kind === "item" || spec.kind === "team" || spec.kind === "user") && !(a.t === "str" || a.t === "ref" || a.t === "var" || (a.t === "fn" && spec.kind === "user"))) {
        err("CQL_TYPE_MISMATCH", `\`${def.name}()\` takes a ${spec.kind === "item" ? "ticket key" : spec.kind} here.`, a);
      }
    });
    const want = fnReturnsFor(kind);
    // Item-set functions are also valid against `key` (and a bare clause).
    if (!want.includes(def.returns)) {
      err("CQL_TYPE_MISMATCH", `\`${def.name}()\` returns ${def.returns === "datetime" ? "a date" : `${def.returns}s`}, which doesn't fit here.`, v);
      return null;
    }
    if (def.many && !inList) {
      err("CQL_TYPE_MISMATCH", `\`${def.name}()\` returns several values; use \`IN ${def.name}()\`.`, v);
      return null;
    }
    return { ...v, name: def.name };
  }

  /** Check (and canonicalise) one value for a field kind. */
  function checkValue(v: CqlValue, kind: ValueKind, ctx: { inList: boolean; allowEmpty: boolean; field: string }): CqlValue | null {
    if (v.t === "var") return v;
    if (v.t === "fn") return checkFunction(v, kind, ctx.inList);
    if (v.t === "empty") {
      if (!ctx.allowEmpty) {
        err("CQL_TYPE_MISMATCH", `\`${ctx.field}\` is never empty.`, v);
        return null;
      }
      return v;
    }
    switch (kind.kind) {
      case "ref":
        if (v.t === "ref") {
          if (v.entity !== kind.entity) {
            err("CQL_TYPE_MISMATCH", `Expected a ${kind.entity}, got a ${v.entity}.`, v);
            return null;
          }
          return v;
        }
        if (v.t === "str" || (v.t === "num" && kind.entity === "item")) return v;
        err("CQL_TYPE_MISMATCH", `\`${ctx.field}\` takes a name${kind.entity === "user" ? ", `me`" : ""} or id.`, v);
        return null;
      case "enum": {
        if (v.t !== "str") {
          err("CQL_TYPE_MISMATCH", `\`${ctx.field}\` is one of ${kind.values.join(", ")}.`, v);
          return null;
        }
        const raw = v.v.trim();
        const canon =
          kind.values.find((x) => x.toLowerCase() === raw.toLowerCase())
          ?? (ctx.field === "statusCategory" ? CATEGORY_ALIASES[raw.toLowerCase()] : undefined);
        if (!canon) {
          const near = suggest(raw, kind.values);
          err("CQL_UNKNOWN_VALUE", `\`${raw}\` is not a ${ctx.field} value; use one of ${kind.values.join(", ")}.`, v, near.length ? `Did you mean \`${near[0]}\`?` : undefined);
          return null;
        }
        const out: CqlValue = { t: "str", v: canon };
        spans?.set(out, at(v));
        return out;
      }
      case "bool":
        if (v.t === "bool") return v;
        err("CQL_TYPE_MISMATCH", `\`${ctx.field}\` is \`true\` or \`false\`.`, v);
        return null;
      case "number":
        if (v.t === "num") return v;
        err("CQL_TYPE_MISMATCH", `\`${ctx.field}\` takes a number.`, v);
        return null;
      case "duration":
        if (v.t === "rel" && /^\+?\d+(w|d|h|m)$/.test(v.v)) return v;
        err("CQL_TYPE_MISMATCH", `\`${ctx.field}\` takes a duration such as \`2h\` or \`3d\` (1d = 8h, 1w = 5d).`, v);
        return null;
      case "date":
      case "datetime":
        if (v.t === "date" || (v.t === "rel" && REL_RE.test(v.v))) return v;
        if (v.t === "str" && /^\d{4}-\d{2}-\d{2}/.test(v.v)) return { t: "date", v: v.v };
        err("CQL_TYPE_MISMATCH", `\`${ctx.field}\` takes a date (\`2026-10-31\`), an offset (\`-7d\`) or a function (\`now()\`).`, v);
        return null;
      case "text":
      case "string":
        if (v.t === "str") return v;
        if (v.t === "num") return { t: "str", v: String(v.v) };
        err("CQL_TYPE_MISMATCH", `\`${ctx.field}\` takes text.`, v);
        return null;
    }
  }

  function checkLeaf(n: LeafNode): CqlNode | null {
    const f = resolveField(n.field);
    if (!f) return null;
    const ops = f.def ? f.def.ops : CF_OPS[f.cf!.fieldType];
    const kind = f.def ? f.def.value : cfValueKind(f.cf!.fieldType);
    const name = f.def ? f.def.id : f.cf!.name;
    const fam = familyOf(n);

    if (fam === "history") {
      if (f.cf || !isHistoryField(f.def!.id)) {
        err("CQL_HISTORY_UNSUPPORTED", `History (WAS / CHANGED) is kept only for ${HISTORY_FIELDS.join(", ")}.`, n);
        return null;
      }
      err("CQL_NOT_YET_SUPPORTED", "WAS and CHANGED arrive with query phase 4.", n);
      return null;
    }
    if (!ops.includes(fam)) {
      err("CQL_OPERATOR_NOT_SUPPORTED", `${OP_TEXT[fam]} doesn't work on \`${name}\`; ${opAdvice(ops)}.`, n);
      return null;
    }
    if (fam === "order" && kind.kind === "ref" && f.def?.id !== "key") {
      err("CQL_OPERATOR_NOT_SUPPORTED", `\`${name}\` has no order; ${opAdvice(ops)}.`, n);
      return null;
    }
    if (f.cf && fam === "empty") {
      err("CQL_NOT_YET_SUPPORTED", "`IS EMPTY` on custom fields arrives with query phase 4.", n);
      return null;
    }
    const allowEmpty = ops.includes("empty");
    const field = f.ref;

    switch (n.op) {
      case "cmp": {
        // `sprint = openSprints()` is the IN it plainly means (and != the NOT IN).
        const setOk = n.cmp === "eq" || n.cmp === "neq";
        const value = checkValue(n.value, kind, { inList: setOk, allowEmpty, field: name });
        if (!value) return null;
        if (value.t === "fn" && lookupFunction(value.name)?.many) {
          return { op: "in", field, ...(n.cmp === "neq" ? { negate: true } : {}), values: [value] };
        }
        if (n.cmp === "neq" && NULLABLE.has(name)) warnNeq(n, name);
        return { ...n, field, value };
      }
      case "in": {
        const values = n.values
          .map((v) => checkValue(v, kind, { inList: true, allowEmpty, field: name }))
          .filter((v): v is CqlValue => !!v);
        if (values.length !== n.values.length) return null;
        if (n.negate && NULLABLE.has(name) && !values.some((v) => v.t === "empty")) warnNeq(n, name);
        return { ...n, field, values };
      }
      case "empty":
        return { ...n, field };
      case "text": {
        if (!n.query.trim()) {
          err("CQL_TYPE_MISMATCH", "Give some text to search for.", n);
          return null;
        }
        if (n.query.includes("*") && !/^[^*]+\*$/.test(n.query.trim())) {
          err("CQL_TYPE_MISMATCH", "`*` works only at the end, as a prefix match: `\"log*\"`.", n);
          return null;
        }
        return { ...n, field };
      }
      default:
        return null;
    }
  }

  function warnNeq(n: LeafNode, name: string) {
    const span = at(n);
    const clauseText = span.to > span.from ? text.slice(span.from, span.to) : "";
    diagnostics.push(
      diag(
        text,
        "CQL_NEQ_EXCLUDES_EMPTY",
        `This also hides items with no ${name}. Add \`OR ${name} IS EMPTY\` to keep them.`,
        span,
        {
          severity: "warning",
          ...(clauseText
            ? { fixes: [{ label: `Include items with no ${name}`, replace: { from: span.from, to: span.to, insert: `(${clauseText} OR ${name} IS EMPTY)` } }] }
            : {}),
        },
      ),
    );
  }

  function walk(n: CqlNode): CqlNode | null {
    switch (n.op) {
      case "and":
      case "or": {
        const args = n.args.map(walk);
        if (args.some((a) => !a)) return null;
        return { op: n.op, args: args as CqlNode[] };
      }
      case "not": {
        const arg = walk(n.arg);
        return arg ? { op: "not", arg } : null;
      }
      default:
        return checkLeaf(n);
    }
  }

  function checkSort(s: CqlSort): CqlSort | null {
    const f = resolveField(s.field);
    if (!f) return null;
    if (f.cf || (f.def && ["assignee", "status", "project"].includes(f.def.id))) {
      err("CQL_NOT_YET_SUPPORTED", `Sorting by \`${f.cf ? f.cf.name : f.def!.id}\` arrives with query phase 4.`, s);
      return null;
    }
    if (!f.def!.sortable) {
      err("CQL_OPERATOR_NOT_SUPPORTED", `Can't sort by \`${printField(s.field)}\`.`, s);
      return null;
    }
    return { ...s, field: f.ref };
  }

  const where = input.where ? walk(input.where) : null;
  const orderBy = input.orderBy?.map(checkSort);
  const query: CqlQuery = {
    v: CQL_VERSION,
    where: input.where ? where : null,
    ...(orderBy ? { orderBy: orderBy.filter((s): s is CqlSort => !!s) } : {}),
    ...(input.context ? { context: input.context } : {}),
  };
  return { query, diagnostics };
}
