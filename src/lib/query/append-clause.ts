/**
 * Add ONE condition to a query, whatever shape that query is in.
 *
 * This exists because `fromChips` can't do it. Chips are a view of the WHOLE
 * query: every chip edit reprints the entire tree, so it is only sound for
 * queries `toChips` accepted — which rules out groups, OR-of-ANDs, NOT and the
 * history operators. Appending reads none of that. It wraps whatever is there
 * in `AND (…)` and leaves it untouched, so it is sound for every query that
 * PARSES, including the ones Basic mode must refuse.
 *
 * That asymmetry is the whole point: "Add filter" can be offered next to the
 * CQL editor, where a filter dropdown was previously unavailable (FR ad579c82,
 * "I should simply be able to add the filters from the dropdown on the right").
 *
 * Fails CLOSED on a query that doesn't parse: appending to a broken tree would
 * print back a canonical query that silently discards whatever the user was
 * half-way through typing.
 *
 * Pure and client-safe.
 */
import { CQL_VERSION, sameField, type CqlNode, type FieldRef } from "./ast";
import { chipToNodes, type Chip } from "./basic";
import { parseCql } from "./parser";
import { printCql } from "./print";

export type AppendResult = { ok: true; cql: string } | { ok: false; reason: string };

/** `where AND <chip>`, as text. ORDER BY and everything else ride along. */
export function appendChip(cql: string, chip: Chip): AppendResult {
  const nodes = chipToNodes(chip);
  if (nodes.length === 0) return { ok: false, reason: "that filter says nothing" };

  if (!cql.trim()) {
    const where = nodes.length === 1 ? nodes[0] : ({ op: "and", args: nodes } as CqlNode);
    return { ok: true, cql: printCql({ v: CQL_VERSION, where }) };
  }

  const parsed = parseCql(cql);
  if (parsed.diagnostics.some((d) => d.severity === "error")) {
    return { ok: false, reason: "the query has a syntax error — fix it first" };
  }

  const prev = parsed.query.where;
  // Flattening a top-level AND keeps the printed text as `a AND b AND c`
  // rather than `(a AND b) AND c`; an OR stays whole and gets its parentheses
  // from the printer, so `a OR b` + `c` is `(a OR b) AND c`, never `a OR b AND c`.
  const where: CqlNode =
    prev === null
      ? nodes.length === 1
        ? nodes[0]
        : { op: "and", args: nodes }
      : prev.op === "and"
        ? { op: "and", args: [...prev.args, ...nodes] }
        : { op: "and", args: [prev, ...nodes] };

  return { ok: true, cql: printCql({ ...parsed.query, where }) };
}

/**
 * Every field the query mentions, once each, in the order first seen.
 *
 * Used to grey out a field in "Add filter" that the query already constrains:
 * appending a second condition on one field is legal CQL but almost never what
 * somebody means by adding a filter, and chips refuse it outright
 * ("has two conditions on one field").
 */
export function fieldsIn(cql: string): FieldRef[] {
  const parsed = parseCql(cql);
  if (parsed.diagnostics.some((d) => d.severity === "error")) return [];
  const out: FieldRef[] = [];
  const walk = (n: CqlNode | null) => {
    if (!n) return;
    if (n.op === "and" || n.op === "or") return n.args.forEach(walk);
    if (n.op === "not") return walk(n.arg);
    if (!out.some((f) => sameField(f, n.field))) out.push(n.field);
  };
  walk(parsed.query.where);
  return out;
}
