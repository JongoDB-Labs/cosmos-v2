/**
 * Normal form and limits for a CqlQuery.
 *
 * `normalize` flattens nested and/or, unwraps single-argument groups and turns
 * `= EMPTY` into `IS EMPTY`. It reorders NOTHING: clause order is the user's.
 * `hashQuery(normalize(q))` is the cache key for results (React Query keys,
 * subscription "changed since last send").
 *
 * `validateAst` enforces the size limits on a query that arrives as JSON (a
 * dashboard panel, a saved filter, an API caller); text is limited by the parser.
 */
import {
  CQL_LIMITS,
  cqlQuerySchema,
  nodeDepth,
  walkLeaves,
  type CqlNode,
  type CqlQuery,
} from "./ast";
import { diag, type CqlDiagnostic } from "./errors";

export function normalizeNode(n: CqlNode): CqlNode {
  switch (n.op) {
    case "and":
    case "or": {
      const flat: CqlNode[] = [];
      for (const a of n.args.map(normalizeNode)) {
        if (a.op === n.op) flat.push(...a.args);
        else flat.push(a);
      }
      return flat.length === 1 ? flat[0] : { op: n.op, args: flat };
    }
    case "not":
      return { op: "not", arg: normalizeNode(n.arg) };
    case "cmp":
      if (n.value.t === "empty" && (n.cmp === "eq" || n.cmp === "neq")) {
        return { op: "empty", field: n.field, ...(n.cmp === "neq" ? { negate: true } : {}) };
      }
      return n;
    default:
      return n;
  }
}

export function normalize(q: CqlQuery): CqlQuery {
  return { ...q, where: q.where ? normalizeNode(q.where) : null };
}

/** Deterministic JSON: object keys sorted, so equal queries hash equally. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** FNV-1a 64-bit as hex. A cache key, not a security boundary. */
export function hashQuery(q: CqlQuery): string {
  const s = stableStringify(normalize(q));
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export function countClauses(q: CqlQuery): { clauses: number; history: number } {
  let clauses = 0;
  let history = 0;
  walkLeaves(q.where, (l) => {
    clauses++;
    if (l.op === "was" || l.op === "changed") history++;
  });
  return { clauses, history };
}

/** Size limits shared by text and JSON queries (text has its own length limit). */
export function limitDiagnostics(q: CqlQuery, text = ""): CqlDiagnostic[] {
  const out: CqlDiagnostic[] = [];
  const { clauses, history } = countClauses(q);
  if (clauses > CQL_LIMITS.clauses) {
    out.push(diag(text, "CQL_LIMIT", `A query can have at most ${CQL_LIMITS.clauses} conditions (this has ${clauses}).`));
  }
  if (history > CQL_LIMITS.historyClauses) {
    out.push(diag(text, "CQL_LIMIT", `A query can have at most ${CQL_LIMITS.historyClauses} WAS / CHANGED conditions.`));
  }
  if ((q.orderBy?.length ?? 0) > CQL_LIMITS.sortKeys) {
    out.push(diag(text, "CQL_LIMIT", `ORDER BY takes at most ${CQL_LIMITS.sortKeys} fields.`));
  }
  if (nodeDepth(q.where) > CQL_LIMITS.nodeDepth) {
    out.push(diag(text, "CQL_LIMIT", `Conditions can nest at most ${CQL_LIMITS.nodeDepth} levels deep.`));
  }
  walkLeaves(q.where, (l) => {
    if ((l.op === "in" || l.op === "was") && l.values.length > CQL_LIMITS.inValues) {
      out.push(diag(text, "CQL_LIMIT", `An IN list takes at most ${CQL_LIMITS.inValues} values.`));
    }
  });
  return out;
}

/** Validate a JSON query: shape (zod) then limits. Returns the parsed query or diagnostics. */
export function validateAst(input: unknown): { query: CqlQuery; diagnostics: [] } | { query: null; diagnostics: CqlDiagnostic[] } {
  const parsed = cqlQuerySchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      query: null,
      diagnostics: [
        diag("", "CQL_INVALID_AST", `Invalid query JSON at ${first?.path.join(".") || "(root)"}: ${first?.message ?? "invalid"}.`),
      ],
    };
  }
  const q = normalize(parsed.data);
  const limits = limitDiagnostics(q);
  return limits.length ? { query: null, diagnostics: limits } : { query: q, diagnostics: [] };
}
