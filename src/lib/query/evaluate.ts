/**
 * Does one loaded work item satisfy a compiled CQL predicate? (query design
 * §12.1). Boards load their project's items and filter in the browser, so the
 * board can't run SQL; but it must give a query the SAME meaning the server
 * does, or a board disagrees with the Issues list it was saved from.
 *
 * So this does not re-implement CQL. It interprets the Prisma where that
 * `compile.ts` produced (fetched from `POST cql/predicate`), with SQL's
 * three-valued logic: a comparison with NULL is unknown, NOT unknown is
 * unknown, and a row matches only when the whole predicate is TRUE. One
 * compiler, two executors; `evaluate.db.test.ts` runs both over the same rows.
 *
 * Some predicates need data a board row doesn't carry (comments, watchers,
 * label ids, links, history). Those evaluate to UNDECIDED, and the board asks
 * the server for the matching ids instead. Never a guess.
 *
 * Client-safe: imports nothing.
 */

/** Can't be decided from the row: the data isn't there. */
export const UNDECIDED = "undecided" as const;
/** SQL three-valued logic, plus "can't tell from this row". */
export type Truth = boolean | null | typeof UNDECIDED;

/** How the predicate route marks Prisma's JSON null sentinels on the wire. */
export type NullMarker = { $null: "AnyNull" | "DbNull" | "JsonNull" };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
const isNullMarker = (v: unknown): v is NullMarker => isObj(v) && typeof v.$null === "string";

/** Kleene AND / OR / NOT, with UNDECIDED absorbing everything but a decisive answer. */
function and(xs: Truth[]): Truth {
  if (xs.includes(false)) return false;
  if (xs.includes(UNDECIDED)) return UNDECIDED;
  if (xs.includes(null)) return null;
  return true;
}
function or(xs: Truth[]): Truth {
  if (xs.includes(true)) return true;
  if (xs.includes(UNDECIDED)) return UNDECIDED;
  if (xs.includes(null)) return null;
  return false;
}
function not(x: Truth): Truth {
  return x === UNDECIDED || x === null ? x : !x;
}

/** Does a row match? Only TRUE matches; UNDECIDED says "ask the server". */
export function matches(where: unknown, item: Obj): boolean | typeof UNDECIDED {
  const t = evalWhere(where, item);
  return t === UNDECIDED ? UNDECIDED : t === true;
}

export function evalWhere(where: unknown, item: Obj): Truth {
  if (Array.isArray(where)) return and(where.map((w) => evalWhere(w, item)));
  if (!isObj(where)) return true;
  const parts: Truth[] = [];
  for (const [key, f] of Object.entries(where)) {
    if (f === undefined) continue;
    if (key === "AND") parts.push(Array.isArray(f) ? and(f.map((w) => evalWhere(w, item))) : evalWhere(f, item));
    else if (key === "OR") parts.push(Array.isArray(f) ? or(f.map((w) => evalWhere(w, item))) : evalWhere(f, item));
    else if (key === "NOT") parts.push(Array.isArray(f) ? and(f.map((w) => not(evalWhere(w, item)))) : not(evalWhere(f, item)));
    else parts.push(evalField(key, f, item));
  }
  return and(parts);
}

function evalField(key: string, f: unknown, item: Obj): Truth {
  const value = item[key];
  // A relation the row doesn't carry.
  if (isObj(f) && ("some" in f || "none" in f || "every" in f)) {
    if (!Array.isArray(value)) return UNDECIDED;
    const rows = value as Obj[];
    if ("some" in f) return or(rows.map((r) => evalWhere(f.some, r)));
    if ("none" in f) return not(or(rows.map((r) => evalWhere(f.none, r))));
    return and(rows.map((r) => evalWhere(f.every, r)));
  }
  if (!(key in item)) return UNDECIDED;
  if (isObj(f) && "path" in f) return evalJsonPath(f, value);
  return evalScalar(f, value);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const timeOf = (v: unknown): number | null =>
  v instanceof Date ? v.getTime() : typeof v === "string" && ISO.test(v) ? Date.parse(v) : null;

/** SQL comparison of two non-null values: as instants when both are, else as numbers / strings. */
function cmp(a: unknown, b: unknown): number {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta !== null && tb !== null) return ta - tb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** A LIKE operand back to plain text: Prisma's contains / startsWith take escaped `\%`, `\_`, `\\`. */
const unescapeLike = (s: string) => s.replace(/\\([\\%_])/g, "$1");

function evalScalar(f: unknown, value: unknown): Truth {
  const isNull = value === null || value === undefined;
  // Shorthand: `{ col: null }` is IS NULL (two-valued); `{ col: v }` is `= v`.
  if (f === null) return isNull;
  if (!isObj(f)) return isNull ? null : cmp(value, f) === 0;
  const insensitive = f.mode === "insensitive";
  const text = (v: unknown) => (insensitive ? String(v).toLowerCase() : String(v));
  const parts: Truth[] = [];
  for (const [op, arg] of Object.entries(f)) {
    if (arg === undefined || op === "mode") continue;
    switch (op) {
      case "equals":
        parts.push(arg === null ? isNull : isNull ? null : insensitive ? text(value) === text(arg) : cmp(value, arg) === 0);
        break;
      case "not":
        if (arg === null) parts.push(!isNull);
        else if (isObj(arg)) parts.push(not(evalScalar({ ...arg, ...(insensitive ? { mode: "insensitive" } : {}) }, value)));
        else parts.push(isNull ? null : cmp(value, arg) !== 0);
        break;
      case "in":
        // Prisma renders an empty IN as false, NULL or not.
        parts.push((arg as unknown[]).length === 0 ? false : isNull ? null : (arg as unknown[]).some((x) => cmp(value, x) === 0));
        break;
      case "notIn":
        parts.push((arg as unknown[]).length === 0 ? true : isNull ? null : !(arg as unknown[]).some((x) => cmp(value, x) === 0));
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (isNull || arg === null) {
          parts.push(null);
          break;
        }
        const c = cmp(value, arg);
        parts.push(op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0);
        break;
      }
      case "contains":
      case "startsWith":
      case "endsWith": {
        if (isNull) {
          parts.push(null);
          break;
        }
        const v = text(value);
        const q = text(unescapeLike(String(arg)));
        parts.push(op === "contains" ? v.includes(q) : op === "startsWith" ? v.startsWith(q) : v.endsWith(q));
        break;
      }
      default:
        // An operator this interpreter doesn't know: never guess.
        return UNDECIDED;
    }
  }
  return and(parts);
}

/** `{ path: [key], equals | array_contains | string_contains | … }` on a JSON column. */
function evalJsonPath(f: Obj, column: unknown): Truth {
  const path = f.path as string[];
  let v: unknown = column;
  for (const k of path) v = isObj(v) && k in v ? v[k] : undefined;
  // `#>` on a missing key is SQL NULL; a JSON null is a JSON value.
  const sqlNull = v === undefined;
  const insensitive = f.mode === "insensitive";
  const parts: Truth[] = [];
  for (const [op, arg] of Object.entries(f)) {
    if (op === "path" || op === "mode" || arg === undefined) continue;
    switch (op) {
      case "equals": {
        if (isNullMarker(arg)) {
          const kind = arg.$null;
          parts.push(kind === "AnyNull" ? sqlNull || v === null : kind === "JsonNull" ? !sqlNull && v === null : sqlNull);
        } else {
          parts.push(sqlNull ? null : JSON.stringify(v) === JSON.stringify(arg));
        }
        break;
      }
      case "array_contains": {
        if (sqlNull) {
          parts.push(null);
          break;
        }
        const want = Array.isArray(arg) ? arg : [arg];
        parts.push(Array.isArray(v) && want.every((x) => (v as unknown[]).some((y) => JSON.stringify(y) === JSON.stringify(x))));
        break;
      }
      case "string_contains":
      case "string_starts_with":
      case "string_ends_with": {
        if (sqlNull || typeof v !== "string") {
          parts.push(sqlNull ? null : false);
          break;
        }
        const s = insensitive ? v.toLowerCase() : v;
        const q = unescapeLike(String(arg));
        const qq = insensitive ? q.toLowerCase() : q;
        parts.push(op === "string_contains" ? s.includes(qq) : op === "string_starts_with" ? s.startsWith(qq) : s.endsWith(qq));
        break;
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (sqlNull || v === null || typeof v !== typeof arg) {
          parts.push(sqlNull || v === null ? null : false);
          break;
        }
        const c = cmp(v, arg);
        parts.push(op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0);
        break;
      }
      default:
        return UNDECIDED;
    }
  }
  return and(parts);
}
