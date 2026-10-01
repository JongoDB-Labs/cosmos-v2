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
// It is a RATCHET, not a clean bill of health. 22 columns are still
// listed below; the assertion is that the set does not grow. Fixing one means
// deleting its line here, which is the point.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BARE_USER_REF_COLUMNS, buildModelPlans, fkEdgesOf } from "./model-graph";

const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

/** A scalar uuid column whose name denotes a person. */
const USERISH = /^(user|owner|author|actor|assignee|member)_id$|^\w+_by_id$/;

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
 *  What is left is left because the evidence stops one hop short, not because
 *  nobody looked. Three shapes, so the next pass can start from here:
 *
 *    - TABLE IS EMPTY, and the write assigns from a function parameter rather
 *      than the auth context, so neither the data nor one grep settles it:
 *      documents.uploaded_by_id, employees.user_id, flags.user_id,
 *      entity_references.created_by_id, employee_cost_rates.created_by_id.
 *      Tracing the callers would settle each one.
 *    - GENUINELY AMBIGUOUS in the domain: goals.owner_id — an "owner" may be a
 *      person or a team, and the column cannot say which. Its API accepts any
 *      uuid and nothing in the goals components renders it, so neither the data
 *      nor the UI settles it. milestones.owner_id LOOKED identical and was not:
 *      its component builds the owner map keyed by `m.userId` and looks it up by
 *      `ownerId`, so it is registered. retro_action_items.owner_id and
 *      retro_notes.author_id looked like gaps and were never bare at all — both
 *      are real foreign keys, which is why the derivation now subtracts what
 *      fkEdgesOf() reports rather than deciding for itself.
 *    - NO WRITE FOUND anywhere under src/, so something outside the app writes
 *      them (a job, a seed, raw SQL): the timesheets.* and payroll columns,
 *      time_entries.billed_by_id / voided_by_id, invoices/payments/pay_runs. */
const KNOWN_GAPS: readonly string[] = [
  "bills.created_by_id",
  "documents.uploaded_by_id",
  "employee_cost_rates.created_by_id",
  "employee_supervisors.created_by_id",
  "employees.created_by_id",
  "employees.user_id",
  "entity_references.created_by_id",
  "flags.resolved_by_id",
  "flags.user_id",
  "goals.owner_id",
  "invoices.created_by_id",
  "key_result_checkins.checked_in_by_id",
  "pay_runs.created_by_id",
  "payments.created_by_id",
  "tax_rates.created_by_id",
  "time_entries.billed_by_id",
  "time_entries.voided_by_id",
  "time_entry_revisions.actor_id",
  "time_off_requests.decided_by_id",
  "timesheets.cost_approved_by_id",
  "timesheets.labor_approved_by_id",
  "timesheets.user_id",
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
    for (const f of body.matchAll(/^\s+(\w+)\s+String\??\s+([^\n]*)$/gm)) {
      const [, field, rest] = f;
      if (!rest.includes("@db.Uuid") || related.has(field)) continue;
      const col = /@map\("([a-z_]+)"\)/.exec(rest)?.[1];
      if (col && USERISH.test(col)) out.push(`${table}.${col}`);
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

  it("registers every bare user reference, except the known gaps", () => {
    const listed = new Set(
      [...BARE_USER_REF_COLUMNS].flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`)),
    );
    const unregistered = derived.filter((c) => !listed.has(c));
    expect(unregistered).toEqual([...KNOWN_GAPS]);
  });
});
