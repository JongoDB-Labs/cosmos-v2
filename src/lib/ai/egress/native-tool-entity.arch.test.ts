// @vitest-environment node
//
// Every NATIVE tool must have a TOOL_ENTITY entry.
//
// `modelView` is default-deny and keys off the entity: "Unknown entityType or
// non-entity value ⇒ full withhold". So a tool missing from TOOL_ENTITY does
// not leak — it goes BLANK on the withheld (gov) path while working perfectly
// in commercial-unclassified, which is the hardest kind of gap to notice. You
// would have to run a gov-tenant conversation to see it at all.
//
// Connectors already had this covered (connectors/registry.test.ts and friends
// assert their descriptors round-trip). Native tools had NO such guard, so
// adding one native tool and forgetting one line in projection.ts was silent.
// `get_work_item` was added that way and this is the rule that would have
// caught it.
import { describe, it, expect } from "vitest";
import { cosmosTools } from "@/lib/ai/tools";
import { TOOL_ENTITY, EXPOSABLE_FIELDS } from "./projection";
import { connectorToolDefs } from "@/lib/ai/connectors";

const CONNECTOR = new Set(connectorToolDefs().map((t) => t.name));
const native = () => cosmosTools.filter((t) => !CONNECTOR.has(t.name));

/**
 * Tools that intentionally return no tenant entity, so there is nothing for the
 * projection to key off. Each must be a tool whose result is not org data.
 */
const NO_ENTITY = new Set([
  // Returns the fetched text of an EXTERNAL url — not a tenant entity.
  "fetch_url",
  // A stub returning a fixed sentence.
  "process_transcript",
  // Describes the QUERY LANGUAGE — operators, functions, field names. Metadata
  // about the schema, not rows from it.
  "describe_cql",
]);

/**
 * UNMAPPED TODAY — a RATCHET, not an exemption.
 *
 * These 15 native tools have no TOOL_ENTITY entry, so `modelView` full-withholds
 * their results on the gov path. That is fail-CLOSED, so none of it is a leak,
 * and for the finance tools it may well be intended (that projection drops
 * money by policy). But none of it is written down anywhere, and a blank answer
 * in a gov tenant is indistinguishable from a broken tool.
 *
 * Deliberately NOT resolved by adding fifteen entries here: each one means
 * allowlisting specific fields through a CUI-withholding floor, and
 * projection.ts is explicit that "when a field's safety was genuinely
 * ambiguous it was REMOVED — it is always safe to withhold more". Fifteen
 * unverified allowlists would be the opposite of that.
 *
 * So this list only ever SHRINKS. The second assertion below fails if an entry
 * is no longer unmapped, which forces it off the list when someone maps it; and
 * the first fails for any NEW unmapped tool. A ratchet whose quantity can only
 * go down, because the last one here that could only go up turned out to be
 * stale in 14 of 20 cases.
 */
const UNMAPPED_TODAY = new Set([
  "query_finance", "log_revenue", "log_expense", "get_finance_summary",
  "get_trial_balance", "get_profit_and_loss",
  "list_risks", "create_risk", "update_risk", "add_pm_comment",
  "generate_interval_brief",
]);

describe("native tools are known to the egress projection", () => {
  it("has native tools to check", () => {
    // Guards the guard: an empty list would make the rule below vacuous, which
    // is how a grep-based arch rule usually dies.
    expect(native().length).toBeGreaterThan(50);
  });

  it("no NEW native tool is missing its entity mapping", () => {
    const unmapped = native()
      .map((t) => t.name)
      .filter((n) => !NO_ENTITY.has(n) && !UNMAPPED_TODAY.has(n) && !TOOL_ENTITY[n]);

    expect(
      unmapped,
      "add the tool to NATIVE_TOOL_ENTITY in egress/projection.ts — without it `modelView` full-withholds the result on the gov path, silently, while commercial works fine",
    ).toEqual([]);
  });

  it("the unmapped list only shrinks", () => {
    // An entry that HAS been mapped must come off the list, or the list stops
    // describing anything and starts hiding the next regression.
    const nowMapped = [...UNMAPPED_TODAY].filter((n) => TOOL_ENTITY[n]);
    expect(
      nowMapped,
      "these are mapped now — remove them from UNMAPPED_TODAY",
    ).toEqual([]);

    const offered = new Set(native().map((t) => t.name));
    expect(
      [...UNMAPPED_TODAY].filter((n) => !offered.has(n)),
      "these are no longer offered — remove them from UNMAPPED_TODAY",
    ).toEqual([]);
  });

  it("every mapped entity has an exposable-field list", () => {
    // A mapping to an entity nobody allowlisted fields for withholds every
    // field — the same blank result by a different route.
    const entities = [...new Set(native().map((t) => TOOL_ENTITY[t.name]).filter(Boolean))];
    expect(entities.length).toBeGreaterThan(5);
    expect(entities.filter((e) => !EXPOSABLE_FIELDS[e])).toEqual([]);
  });

  it("content fields stay OUT of work_item's exposable list", () => {
    // The floor this file protects: `description` is the body text, and
    // get_work_item returns it. It must survive only on the commercial path,
    // by being absent here — never allowlisted. Same for title and tags.
    for (const content of ["description", "title", "tags", "assigneeName", "reporterName"]) {
      expect(
        EXPOSABLE_FIELDS["work_item"],
        `${content} is content/PII and must drop by default-deny`,
      ).not.toContain(content);
    }
    // Positive control: the structural fields ARE allowlisted, so the
    // assertions above are not passing against an empty list.
    expect(EXPOSABLE_FIELDS["work_item"]).toContain("ticketNumber");
  });
});
