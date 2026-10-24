/**
 * CqlQuery → canonical CQL text.
 *
 * Refs print with their CURRENT label (pass `labelFor` to look names up at print
 * time; the stored `label` is only a fallback hint), so a renamed sprint prints
 * its new name. `parse(print(q))` gives back `q` for every unresolved query, a
 * property the tests check over thousands of generated queries.
 *
 * `labelFor` can also redact: a viewer who cannot see a ref gets `‹restricted›`
 * (saved filters shared beyond their owner, query phase 3).
 */
import type { CqlNode, CqlQuery, CqlSort, CqlValue, FieldRef, HistoryPreds } from "./ast";
import { cqlLexer, Identifier, KEYWORDS } from "./lexer";

export type LabelFor = (v: Extract<CqlValue, { t: "ref" }>) => string | undefined;

const KEYWORD_WORDS = new Set(KEYWORDS.map((k) => k.name.toLowerCase()));
/** Bare words that would read back as something other than a plain string. */
const RESERVED_VALUES = new Set(["me", "true", "false"]);

/** Would this text lex back as exactly one identifier that is a plain value? */
function isBareSafe(s: string): boolean {
  if (!s || KEYWORD_WORDS.has(s.toLowerCase()) || RESERVED_VALUES.has(s.toLowerCase())) return false;
  const { tokens, errors } = cqlLexer.tokenize(s);
  return errors.length === 0 && tokens.length === 1 && tokens[0].tokenType === Identifier && tokens[0].image === s;
}

export function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function word(s: string): string {
  return isBareSafe(s) ? s : quote(s);
}

export function printField(f: FieldRef): string {
  if (f.kind === "sys") return f.id;
  return isBareSafe(f.key) ? `cf[${f.key}]` : `cf[${quote(f.key)}]`;
}

export function printValue(v: CqlValue, labelFor?: LabelFor): string {
  switch (v.t) {
    case "str":
      return word(v.v);
    case "num":
      return String(v.v);
    case "bool":
      return v.v ? "true" : "false";
    case "date":
    case "rel":
      return v.v;
    case "ref":
      return word(labelFor?.(v) ?? v.label ?? v.id);
    case "fn":
      if (v.name === "currentUser" && v.args.length === 0) return "me";
      return `${v.name}(${v.args.map((a) => printValue(a, labelFor)).join(", ")})`;
    case "var":
      return `$${v.name}`;
    case "empty":
      return "EMPTY";
  }
}

function printList(values: CqlValue[], labelFor?: LabelFor): string {
  // A lone set-valued function or variable needs no parentheses:
  // `IN openSprints()`, `IN $team`. `me` does (`IN (me)`), being a bare word.
  const only = values.length === 1 ? values[0] : undefined;
  if (only && (only.t === "var" || (only.t === "fn" && printValue(only) !== "me"))) {
    return printValue(only, labelFor);
  }
  return `(${values.map((v) => printValue(v, labelFor)).join(", ")})`;
}

function printPreds(p: HistoryPreds | undefined, labelFor?: LabelFor): string {
  if (!p) return "";
  const parts: string[] = [];
  if (p.from) parts.push(`FROM ${printValue(p.from, labelFor)}`);
  if (p.to) parts.push(`TO ${printValue(p.to, labelFor)}`);
  if (p.by) parts.push(`BY ${printValue(p.by, labelFor)}`);
  if (p.after) parts.push(`AFTER ${printValue(p.after, labelFor)}`);
  if (p.before) parts.push(`BEFORE ${printValue(p.before, labelFor)}`);
  if (p.on) parts.push(`ON ${printValue(p.on, labelFor)}`);
  if (p.during) parts.push(`DURING (${printValue(p.during[0], labelFor)}, ${printValue(p.during[1], labelFor)})`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

const CMP: Record<string, string> = { eq: "=", neq: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };

/** Binding strength: or < and < not < leaf. */
function rank(n: CqlNode): number {
  return n.op === "or" ? 1 : n.op === "and" ? 2 : n.op === "not" ? 3 : 4;
}

export function printNode(n: CqlNode, labelFor?: LabelFor): string {
  const sub = (child: CqlNode, min: number) => {
    const s = printNode(child, labelFor);
    return rank(child) < min ? `(${s})` : s;
  };
  switch (n.op) {
    case "or":
      // Nested ORs keep their parentheses so the tree round-trips as written.
      return n.args.map((a) => sub(a, a.op === "or" ? 3 : 2)).join(" OR ");
    case "and":
      return n.args.map((a) => sub(a, 3)).join(" AND ");
    case "not":
      return `NOT ${sub(n.arg, 3)}`;
    case "cmp":
      return `${printField(n.field)} ${CMP[n.cmp]} ${printValue(n.value, labelFor)}`;
    case "in":
      return `${printField(n.field)} ${n.negate ? "NOT " : ""}IN ${n.all ? "ALL " : ""}${printList(n.values, labelFor)}`;
    case "empty":
      return `${printField(n.field)} IS ${n.negate ? "NOT " : ""}EMPTY`;
    case "text":
      return `${printField(n.field)} ${n.negate ? "!~" : "~"} ${quote(n.query)}`;
    case "was": {
      const list =
        n.values.length === 1 ? printValue(n.values[0], labelFor) : `IN ${printList(n.values, labelFor)}`;
      return `${printField(n.field)} WAS ${n.negate ? "NOT " : ""}${list}${printPreds(n.preds, labelFor)}`;
    }
    case "changed":
      return `${printField(n.field)} CHANGED${printPreds(n.preds, labelFor)}`;
  }
}

function printSort(s: CqlSort): string {
  return `${printField(s.field)} ${s.dir.toUpperCase()}${s.nulls ? ` NULLS ${s.nulls.toUpperCase()}` : ""}`;
}

export function printCql(q: CqlQuery, labelFor?: LabelFor): string {
  const parts: string[] = [];
  if (q.where) parts.push(printNode(q.where, labelFor));
  if (q.orderBy?.length) parts.push(`ORDER BY ${q.orderBy.map(printSort).join(", ")}`);
  return parts.join(" ");
}
