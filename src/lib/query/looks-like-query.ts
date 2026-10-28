import { lookupField } from "./fields";

/**
 * Does this free text look like somebody trying to write a query?
 *
 * Basic mode is the default and its box is a FREE-TEXT search — the chip model
 * says so outright: "the free-text box IS the `text ~` chip". So a query typed
 * there is searched for LITERALLY, as a phrase, in titles and descriptions. It
 * matches nothing, and nothing explains why: no diagnostic is produced, because
 * nothing was ever parsed as a query.
 *
 * That is the whole of the report "i typed `type == feature` and it showed
 * nothing… i'm not sure what the difference between basic and advanced is".
 * Both halves are the same cause: two boxes that look alike and mean different
 * things.
 *
 * This decides whether to OFFER to run the text as a query. It is a hint, never
 * an action — the text keeps working as a search, and the user chooses.
 *
 * Deliberately conservative. A false positive puts an unwanted prompt on an
 * ordinary search, so the left-hand side must be a field the language actually
 * knows (`lookupField` covers aliases, so `creator` counts). "widget = blue" is
 * someone searching; "status = blue" is someone querying.
 */
export function looksLikeQuery(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;

  // <field> <operator> <something>. The operator must be separated or be a
  // symbol, so `a=b` — a token someone might genuinely search for — does not
  // trip it.
  const m = t.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|~|=|>|<)\s*\S/,
  ) ?? t.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s+(IS|IN|WAS|CHANGED|NOT)\b/i,
  );
  if (!m) return false;

  // A symbol operator with no space either side is more likely a token than a
  // query (`a=b`, `rate=5`). Require a space somewhere around it, which is how
  // people actually write queries.
  if (!/\s/.test(t.slice(m[1].length, m[0].length))) return false;

  return lookupField(m[1]) !== undefined;
}
