// src/lib/ai/egress/projection.ts
//
// modelView structural projection. DEFAULT-DENY: only the fields explicitly
// listed per entityType survive into the model's view; everything else (esp. all
// free-text/content/money) is dropped. Unknown entityType or non-entity value ⇒
// full withhold. This is the field-level floor under the (future) classifier.

/** Structural, non-CUI fields per entity. NEVER add a free-text/content/money field here. */
const EXPOSABLE_FIELDS: Record<string, readonly string[]> = {
  work_item:   ["id", "ticketNumber", "columnKey", "status", "priority", "storyPoints", "dueDate", "startDate", "assigneeId", "projectId", "workItemTypeId", "cycleId", "createdAt", "updatedAt"],
  note:        ["id", "projectId", "visibility", "authorId", "createdAt", "updatedAt"],
  comment:     ["id", "workItemId", "authorId", "createdAt"],
  time_entry:  ["id", "hours", "billable", "date", "userId", "workItemId", "approved", "approvedById"],
  project:     ["id", "slug", "status", "createdAt", "updatedAt"],
  cycle:       ["id", "number", "status", "startDate", "endDate", "projectId"],
  crm_contact: ["id", "stage", "ownerId", "createdAt"],
  org_member:  ["id", "userId", "role", "createdAt"],
  compliance_control: ["id", "framework", "controlId", "status", "dueDate"],
  search_result: ["id", "type", "similarity", "projectId"],
  // Intentionally NO entry (⇒ full withhold) for: finance/accounting (amounts +
  // client are sensitive), google email/doc/event/file/contact (bodies are the
  // worst CUI), generated briefs, fetch_url. Their commercial-unclassified case
  // still flows (the gate exposes BEFORE projection); their withheld case is total.
};

const TOOL_ENTITY: Record<string, string> = {
  query_work_items: "work_item", list_work_items: "work_item",
  create_work_item: "work_item", update_work_item: "work_item", delete_work_item: "work_item",
  create_note: "note", update_note: "note", delete_note: "note",
  add_comment: "comment", list_comments: "comment", delete_comment: "comment",
  log_time: "time_entry", list_time_entries: "time_entry",
  list_projects: "project",
  query_cycles: "cycle", list_cycles: "cycle", create_cycle: "cycle",
  query_crm: "crm_contact",
  list_org_members: "org_member",
  query_compliance_controls: "compliance_control", update_compliance_control: "compliance_control",
  semantic_search: "search_result",
  // No mapping ⇒ undefined ⇒ full withhold: query_finance, get_finance_summary,
  // log_revenue, log_expense, get_trial_balance, get_profit_and_loss,
  // generate_cycle_brief, fetch_url, process_transcript, and all google_* tools.
};

export function entityTypeForTool(toolName: string): string | undefined {
  return TOOL_ENTITY[toolName];
}

const WITHHELD = { withheld: true as const, ref: "withheld:structural" };

function projectOne(value: unknown, fields: readonly string[]): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return WITHHELD;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = src[f];
    // Only keep allowlisted SCALARS (string id/enum/iso-date, number, boolean).
    // Drop nested objects/arrays even if the key is allowlisted — they could
    // carry un-allowlisted CUI. (A scalar allowlisted field is safe by construction.)
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") out[f] = v;
  }
  return out;
}

/**
 * Project a withheld tool result to its model-safe structural view.
 * - unknown entityType ⇒ full withhold.
 * - array ⇒ element-wise projection.
 * - object ⇒ allowlisted top-level scalars only.
 * - anything else (string/number) ⇒ full withhold.
 */
export function projectStructural(value: unknown, entityType: string | undefined): unknown {
  if (!entityType) return WITHHELD;
  const fields = EXPOSABLE_FIELDS[entityType];
  if (!fields) return WITHHELD;
  if (Array.isArray(value)) return value.map((el) => projectOne(el, fields));
  return projectOne(value, fields);
}
