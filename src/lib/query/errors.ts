/**
 * CQL diagnostics: every problem carries a code, a human message and the exact
 * span it refers to, in UTF-16 offsets (CodeMirror's unit). The editor maps them
 * straight onto lint marks and the assistant receives the same JSON to correct
 * itself.
 *
 * Messages about VALUES never distinguish "does not exist" from "you cannot see
 * it" (CQL_UNKNOWN_VALUE), so error text cannot be used to probe for restricted
 * projects, sprints or people.
 */

export type CqlErrorCode =
  | "CQL_SYNTAX"
  | "CQL_UNKNOWN_FIELD"
  | "CQL_UNKNOWN_FUNCTION"
  | "CQL_UNKNOWN_VARIABLE"
  | "CQL_OPERATOR_NOT_SUPPORTED"
  | "CQL_TYPE_MISMATCH"
  | "CQL_UNKNOWN_VALUE"
  | "CQL_AMBIGUOUS_VALUE"
  | "CQL_HISTORY_UNSUPPORTED"
  | "CQL_NOT_YET_SUPPORTED"
  | "CQL_LIMIT"
  | "CQL_TOO_BROAD"
  | "CQL_SORT_TOO_BROAD"
  | "CQL_TIMEOUT"
  | "CQL_CONTEXT_REQUIRED"
  | "CQL_INVALID_AST"
  | "CQL_NEQ_EXCLUDES_EMPTY"
  | "CQL_HISTORY_PARTIAL";

export type Severity = "error" | "warning" | "info";

export interface CqlFix {
  label: string;
  replace: { from: number; to: number; insert: string };
}

export interface CqlDiagnostic {
  code: CqlErrorCode;
  severity: Severity;
  message: string;
  /** UTF-16 offsets into the query text; 0/0 for a JSON query. */
  from: number;
  to: number;
  /** 1-based, for display. */
  line: number;
  column: number;
  hint?: string;
  fixes?: CqlFix[];
}

/** A text span the AST builder remembers for each node, keyed by object identity. */
export interface Span {
  from: number;
  to: number;
}

export function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else col++;
  }
  return { line, column: col };
}

export function diag(
  text: string,
  code: CqlErrorCode,
  message: string,
  span: Span = { from: 0, to: 0 },
  extra: { severity?: Severity; hint?: string; fixes?: CqlFix[] } = {},
): CqlDiagnostic {
  const { line, column } = lineCol(text, span.from);
  return {
    code,
    severity: extra.severity ?? "error",
    message,
    from: span.from,
    to: Math.max(span.to, span.from),
    line,
    column,
    ...(extra.hint ? { hint: extra.hint } : {}),
    ...(extra.fixes ? { fixes: extra.fixes } : {}),
  };
}

export const hasErrors = (d: readonly CqlDiagnostic[]) => d.some((x) => x.severity === "error");

/** Thrown by the server pipeline; routes turn it into `400 { error: { code, diagnostics } }`. */
export class CqlError extends Error {
  constructor(
    public readonly diagnostics: CqlDiagnostic[],
    public readonly status = 400,
  ) {
    super(diagnostics.find((d) => d.severity === "error")?.message ?? "Invalid query");
    this.name = "CqlError";
  }
}

/** Edit distance, for "did you mean" on fields, functions and values. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Closest candidates within a distance that grows with the word's length. */
export function suggest(word: string, candidates: Iterable<string>, max = 3): string[] {
  const w = word.toLowerCase();
  // ⌈len/3⌉: one typo in a short word, a transposition (two edits) in a 4-letter one.
  const limit = Math.max(1, Math.ceil(w.length / 3));
  const scored: [string, number][] = [];
  for (const c of candidates) {
    const d = levenshtein(w, c.toLowerCase());
    if (d <= limit) scored.push([c, d]);
  }
  return scored
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([c]) => c);
}

/**
 * A prefilter's id set past this many items is refused rather than shipped as
 * a giant IN list. Prisma binds one parameter per id and Postgres takes about
 * 32,766 per statement, so this leaves room for the rest of the query; the
 * total over a whole query is checked by MAX_LIST_VALUES (execute.server.ts).
 */
export const ID_SET_MAX = 25_000;

const TOO_BROAD_ADVICE = {
  history: "This history clause covers too many items. Use a shorter window (AFTER, BEFORE, ON or DURING).",
  descendants: "There are too many items under this one to filter by. Use `parent =` or narrow to a project.",
  milestone: "These milestones link too many items to filter by. Name fewer milestones.",
  "milestone-empty": "Too many items have milestones to filter by whether one is set. Use `milestone = …` instead.",
  query: "This query's clauses match too many items to combine. Narrow it with a project or a date range.",
} as const;

/** CQL_TOO_BROAD, with advice that actually narrows the part that was too broad. */
export function tooBroad(what: keyof typeof TOO_BROAD_ADVICE): CqlError {
  // A valid query over budget: 422, like CQL_TIMEOUT.
  return new CqlError([diag("", "CQL_TOO_BROAD", TOO_BROAD_ADVICE[what])], 422);
}
