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
// It is a RATCHET, not a clean bill of health. 38 columns predate it and are
// listed below; the assertion is that the set does not grow. Fixing one means
// deleting its line here, which is the point.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BARE_USER_REF_COLUMNS } from "./model-graph";

const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

/** A scalar uuid column whose name denotes a person. */
const USERISH = /^(user|owner|author|actor|assignee|member)_id$|^\w+_by_id$/;

/** Bare user references that were already unregistered when this test was written.
 *  This list may SHRINK. A new entry means someone added a bare user reference
 *  without registering it — register it instead of listing it here. */
const KNOWN_GAPS: readonly string[] = [
  "bank_accounts.created_by_id",
  "bank_rules.created_by_id",
  "bills.created_by_id",
  "chat_pinned_messages.pinned_by_id",
  "deploy_requests.requested_by_id",
  "documents.uploaded_by_id",
  "employee_cost_rates.created_by_id",
  "employee_supervisors.created_by_id",
  "employees.created_by_id",
  "employees.user_id",
  "entity_references.created_by_id",
  "feedback_attachments.uploaded_by_id",
  "flags.resolved_by_id",
  "flags.user_id",
  "goals.owner_id",
  "integrations.installed_by_id",
  "invoices.created_by_id",
  "key_result_checkins.checked_in_by_id",
  "milestones.owner_id",
  "org_ai_settings.updated_by_id",
  "org_email_settings.updated_by_id",
  "org_plugin_state.enabled_by_id",
  "pay_runs.created_by_id",
  "payments.created_by_id",
  "pm_links.created_by_id",
  "retro_action_items.owner_id",
  "retro_notes.author_id",
  "supervisor_requests.requested_by_id",
  "tax_rates.created_by_id",
  "time_entries.billed_by_id",
  "time_entries.voided_by_id",
  "time_entry_revisions.actor_id",
  "time_off_requests.decided_by_id",
  "time_off_requests.user_id",
  "timesheets.cost_approved_by_id",
  "timesheets.labor_approved_by_id",
  "timesheets.user_id",
  "update_settings.updated_by_id",
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

describe("BARE_USER_REF_COLUMNS completeness", () => {
  const derived = deriveBareUserColumns();

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
