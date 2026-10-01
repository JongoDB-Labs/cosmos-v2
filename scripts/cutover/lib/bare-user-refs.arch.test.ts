// scripts/cutover/lib/bare-user-refs.arch.test.ts
//
// BARE_USER_REF_COLUMNS is the one hand-maintained exception in a module whose
// stated principle is "derived at runtime from the DMMF, never hardcoded". Its
// own comment says these columns "MUST be enumerated by hand".
//
// Nothing checked that the enumeration was COMPLETE. The existing test proves
// that every listed column is a bare ref rather than a hard FK — it cannot see a
// column that was never listed. So the map quietly went stale: on 2026-09-30,
// promoting models out of a vertical plugin added seven bare user references
// across two releases and none of them were registered, which nothing noticed.
//
// A column that is missing here is never probed by discoverOrphanProbeTargets,
// so a cutover verify reports clean over rows pointing at users that did not
// come across. That is the failure this test exists to prevent.
//
// It is a RATCHET, not a clean bill of health. 9 columns are still
// listed below; the assertion is that the set does not grow. Fixing one means
// deleting its line here, which is the point.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BARE_USER_REF_COLUMNS, buildModelPlans, fkEdgesOf } from "./model-graph";

// CORE's own portion only. sync.mjs appends composed plugin models BELOW the
// marker and leaves it in place, so this truncation is correct whether the tree is
// composed or not -- and it has to be. The register this gate checks lives in a
// core file, and core may not name a vertical plugin's tables at all (the identity
// gate rejects it), so a composed read would demand a registration that cannot be
// written. Deterministic either way, rather than passing only in core CI.
const CORE_SCHEMA_END = "// @plugin-schema-fragments";
const rawSchema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
const schema = rawSchema.split(CORE_SCHEMA_END)[0];

/** A uuid column whose name denotes a person.
 *
 *  Two forms were missing until 2026-10-01, and they hid the same column from two
 *  directions: the PLURAL `_ids`, and the role words for people who act on a thing
 *  without owning it (approver, supervisor, reviewer, requester). Between them,
 *  `timesheets.approver_ids` -- the approver set fixed at submit time, and a real
 *  user reference -- was invisible to a gate whose entire job is finding those.
 *  Widening both surfaces exactly that one column across core, so this cost nothing
 *  and closed a hole wide enough to drive a cutover through. */
const USERISH =
  /^(user|owner|author|actor|assignee|member|approver|supervisor|requester|reviewer|employee|recipient)_ids?$|^\w+_by_ids?$/;

/** Bare user references still unregistered. This list may SHRINK, never grow: a
 *  new entry means someone added a bare user reference without registering it,
 *  and the answer is to register it rather than list it here.
 *
 *  Thirteen came off this list on 2026-09-30. What counted as evidence, in
 *  descending order of strength — a wrong entry in the map "would pull the wrong
 *  parent table", so a plausible name was explicitly NOT enough:
 *
 *    1. the live data — every non-null value resolves to a `users` row
 *    2. that model's own create/upsert assigns the field from the auth context
 *       (`ctx.userId`, `user.id`)
 *    3. the schema's own doc comment says outright that it holds a user id
 *
 *  What is left is left because the evidence stops, not because nobody looked.
 *  Every one of the thirteen removed on 2026-10-01 was traced from the column to
 *  a route that passes `ctx.userId`, through that model's OWN create/update — a
 *  grep for the field name alone is not enough, because a dozen models share
 *  names like `createdById` and it will cheerfully attribute the wrong one.
 *
 *  The nine that remain, and what stops each:
 *
 *    - NOTHING UNDER src/ WRITES THEM, so a seed, a job or raw SQL does, and the
 *      app cannot say what they hold: employee_supervisors.created_by_id,
 *      payments.created_by_id, tax_rates.created_by_id, timesheets.user_id,
 *      timesheets.cost_approved_by_id, timesheets.labor_approved_by_id.
 *    - WRITTEN, BUT NOTHING CALLS THE WRITER: flags.resolved_by_id — dismissFlag()
 *      takes a `byId` and no route under src/app calls it.
 *    - NO EVIDENCE EITHER WAY: flags.user_id comes from a caller-supplied subject
 *      and no caller was found; goals.owner_id is accepted from the request body
 *      as any uuid and nothing renders it, so neither the data nor the UI settles
 *      whether an "owner" is a person or a team. */
/**
 * What is deliberately NOT registered, and why. Both are reasoned, not pending.
 *
 * `goals.owner_id` is a PRODUCT question before it is a schema one: a goal's owner
 * may be a person or a team, and the column holds whichever the caller passed.
 * Registering it would make the exporter chase a team id into `users`, find nothing,
 * and report a dangling reference on a row that is perfectly correct. It stays out
 * until the product decides what an owner is.
 *
 * `timesheets.approver_ids[]` IS a user reference — the approver set fixed at submit
 * time — and it cannot go in BARE_USER_REF_COLUMNS, because the closure walker reads
 * `row[fkColumn]` as a single value (`export-core.ts`). Handed an array it would add
 * the array OBJECT to the set of wanted ids, so the follow-up lookup matches nothing
 * and the failure is silent rather than loud. Rewriting it needs an array-aware edge
 * in the walker, which is a change to the walker and not to this list. Named here so
 * a SECOND array column cannot arrive unnoticed the way this one did.
 */
const KNOWN_GAPS: readonly string[] = [
  "goals.owner_id",
  "timesheets.approver_ids[]",
];

function deriveBareUserColumns(): string[] {
  const out: string[] = [];
  for (const m of schema.matchAll(/^model (\w+) \{(.*?)^\}/gms)) {
    const [, name, rawBody] = m;
    // strip comments first: a doc comment naming a column would otherwise read
    // as a declaration.
    const body = rawBody.replace(/^\s*\/\/.*$/gm, "");
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
    const related = new Set<string>();
    for (const r of body.matchAll(/@relation\([^)]*fields: \[([^\]]+)\]/g)) {
      for (const f of r[1].split(",")) related.add(f.trim());
    }
    // String, String? AND String[] — the list form was invisible until 2026-10-01,
    // which is how timesheets.approver_ids sat unexamined. [ \t] not \s: \s matches a
    // newline, which paired a field name with the NEXT field's @map.
    for (const f of body.matchAll(/^[ \t]+(\w+)[ \t]+String(\?|\[\])?[ \t]+([^\n]*)$/gm)) {
      const [, field, listMod, rest] = f;
      if (!rest.includes("@db.Uuid") || related.has(field)) continue;
      const col = /@map\("([a-z_]+)"\)/.exec(rest)?.[1];
      if (col && USERISH.test(col)) out.push(`${table}.${col}${listMod === "[]" ? "[]" : ""}`);
    }
  }
  return out.sort();
}

/** Columns the DMMF already knows are real foreign keys.
 *
 *  The text scan above cannot be the authority on this. It reads the schema as
 *  characters and got RetroActionItem.owner_id wrong — the relation is declared
 *  plainly on one line and it still landed in the "bare" set, which put a hard FK
 *  into the gap list where it sat until the neighbouring test caught it. Rather
 *  than keep two disagreeing implementations, subtract what fkEdgesOf() reports:
 *  it is the same source the rest of this module trusts. */
function hardFkColumns(): Set<string> {
  const out = new Set<string>();
  for (const p of buildModelPlans()) {
    for (const e of fkEdgesOf(p.model)) {
      if (e.hardFk) out.add(`${p.table}.${e.fkColumn}`);
    }
  }
  return out;
}

describe("BARE_USER_REF_COLUMNS completeness", () => {
  const hard = hardFkColumns();
  const derived = deriveBareUserColumns().filter((c) => !hard.has(c));

  it("still finds bare user references at all", () => {
    // floor: if the parser breaks, everything below passes vacuously.
    expect(derived.length).toBeGreaterThan(40);
  });

  it("declares each table once — a duplicate key silently drops the earlier one", () => {
    // `new Map([["t", ["a"]], ["t", ["b"]]])` keeps ONLY ["b"], with no error and
    // no warning. Registering two columns on a table that already had an entry
    // therefore un-registers whatever was there before. That happened on
    // 2026-10-01 to time_entries and time_off_requests; the test below caught it
    // only because the lost columns happened to be user-ish, so a table whose
    // columns fall outside that pattern would have gone quietly.
    const source = readFileSync(join(process.cwd(), "scripts/cutover/lib/model-graph.ts"), "utf8");
    const region = source.slice(
      source.indexOf("BARE_USER_REF_COLUMNS: ReadonlyMap"),
      source.indexOf("]);", source.indexOf("BARE_USER_REF_COLUMNS: ReadonlyMap")),
    );
    const tables = [...region.matchAll(/\["([a-z_]+)",\s*\[/g)].map((m) => m[1]);
    const seen = new Set<string>();
    const dupes = tables.filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
    expect(dupes, `declared more than once in BARE_USER_REF_COLUMNS: ${dupes.join(", ")}`).toEqual([]);
    expect(tables.length).toBeGreaterThan(30); // floor: the literal was found at all
  });

  it("registers every bare user reference, except the known gaps", () => {
    const listed = new Set(
      [...BARE_USER_REF_COLUMNS].flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`)),
    );
    const unregistered = derived.filter((c) => !listed.has(c));
    expect(unregistered).toEqual([...KNOWN_GAPS]);
  });
});
