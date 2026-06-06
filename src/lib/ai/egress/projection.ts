// src/lib/ai/egress/projection.ts
//
// modelView structural projection. DEFAULT-DENY: only the fields explicitly
// listed per entityType survive into the model's view; everything else (esp. all
// free-text/content/money/PII) is dropped. Unknown entityType or non-entity value
// ⇒ full withhold. This is the field-level floor under the (future) classifier.
//
// Every field below is verified against the REAL executor return shape
// (src/lib/ai/executors/*.ts + tool-executor.ts) AND is a structural, non-CUI
// scalar (entity id / enum / iso-timestamp / non-money number / non-PII boolean).
// When a field's safety was genuinely ambiguous it was REMOVED — it is always
// safe to withhold more.

/** Structural, non-CUI fields per entity. NEVER add a free-text/content/money/PII field here. */
const EXPOSABLE_FIELDS: Record<string, readonly string[]> = {
  // listWorkItems/queryWorkItems return `id, ticketNumber, columnKey?, priority,
  // assigneeId, cycleId, storyPoints, dueDate, workItemTypeId, completedAt?, tags`.
  // `columnKey` (FIX A) is unconstrained free text → dropped (orchestrate via id/status).
  // `title`/`description`/`tags` are content/arrays → never allowlisted/kept.
  work_item: [
    "id", "ticketNumber", "status", "priority", "storyPoints",
    "dueDate", "startDate", "completedAt", "assigneeId", "projectId",
    "workItemTypeId", "cycleId", "createdAt", "updatedAt",
  ],
  // createNote/updateNote/deleteNote return `id, title, visibility`. The Note model
  // has NO projectId column (executor ignores the arg) → projectId removed (FIX C).
  // `title` is content → excluded. authorId/timestamps appear on richer shapes.
  note: ["id", "visibility", "authorId", "createdAt", "updatedAt"],
  // addComment/listComments return `id, workItemId?, authorId, createdAt, updatedAt`.
  // `content`/`contentPreview` are CUI → excluded.
  comment: ["id", "workItemId", "authorId", "createdAt", "updatedAt"],
  // listTimeEntries returns `billableType` (enum) + `status` (enum), NOT booleans
  // `billable`/`approved` (FIX C). `rate`/`client`/`description` are money/PII/content.
  time_entry: [
    "id", "hours", "billableType", "status", "date", "userId",
    "projectId", "workItemId", "approvedById", "createdAt", "updatedAt",
  ],
  // listProjects returns `id, name, key, description, archived, enabledFeatures,
  // createdAt, updatedAt`. `name`/`key`/`description` are name-derived/content and
  // sensitive for gov → dropped (FIX C: id + timestamps + structural `archived` only).
  project: ["id", "archived", "createdAt", "updatedAt"],
  // listCycles/createCycle return `id, number, status, cycleKind, startDate, endDate,
  // projectId, createdAt` (+ nested `_count` object, dropped). `name`/`goal`/`report` excluded.
  cycle: ["id", "number", "status", "cycleKind", "startDate", "endDate", "projectId", "createdAt"],
  // queryCrm returns full CrmContact rows. Structural scalars only; `name`/`value`/
  // `dealValue`/`contactInfo`/`notes`/`customFields` are PII/money/content → excluded.
  crm_contact: ["id", "stage", "ownerId", "createdAt", "updatedAt"],
  // listOrgMembers returns `{userId, name, email, role}`. name/email are PII →
  // allowlist ONLY userId + role (FIX C).
  org_member: ["userId", "role"],
  // queryComplianceControls returns `controlId, framework, title, status, notes,
  // dueDate` (+ `id` on update). `title`/`notes` are content → excluded.
  compliance_control: ["id", "framework", "controlId", "status", "dueDate"],
  // semanticSearch hits are `{type, id, title, snippet, similarity, url}`.
  // Expose id/type/similarity ONLY — `title`/`snippet`/`url` are/derive CUI.
  search_result: ["id", "type", "similarity"],
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
 * Project a withheld entity value to its model-safe structural view.
 * - unknown entityType ⇒ full withhold.
 * - array ⇒ element-wise projection.
 * - object ⇒ allowlisted top-level scalars only.
 * - anything else (string/number) ⇒ full withhold.
 *
 * NOTE: read/list executors wrap their items in an object (e.g. `{count, items}`),
 * so the LOOP should call `projectResult` (which unwraps wrappers) — not this
 * directly. This stays exported for the per-element/per-entity unit semantics
 * and for callers that already hold a bare entity or entity[].
 */
export function projectStructural(value: unknown, entityType: string | undefined): unknown {
  if (!entityType) return WITHHELD;
  const fields = EXPOSABLE_FIELDS[entityType];
  if (!fields) return WITHHELD;
  if (Array.isArray(value)) return value.map((el) => projectOne(el, fields));
  return projectOne(value, fields);
}

/**
 * Project a withheld TOOL RESULT (the executor's return value, including its
 * wrapper) to its model-safe structural view. This is what the agent loop uses.
 *
 * Read/list executors return WRAPPERS, not bare arrays — e.g.
 *   listWorkItems        → { count, items: [...] }
 *   listComments         → { count, comments: [...] }
 *   listTimeEntries      → { count, totalHours, entries: [...] }
 *   listProjects         → { count, projects: [...] }
 *   list/queryCycles     → { count, cycles: [...] }
 *   queryCrm             → { count, contacts: [...] }
 *   queryComplianceCtrls → { total, summary, count, controls: [...] }
 *   semanticSearch       → { query, count, results: [...] }
 *   listOrgMembers       → { count, members: [...] }
 * Calling `projectStructural({count, items}, "work_item")` would project the
 * wrapper's OWN top-level keys (not entity keys) → `items` (array) dropped → `{}`.
 * So the model would get nothing useful. `projectResult` unwraps generically:
 *
 * - unknown entityType ⇒ FULL withhold.
 * - array ⇒ element-wise structural projection (a bare entity[] result).
 * - object ⇒ for each top-level key:
 *     • array value      → project it element-wise (the entity collection);
 *     • number/boolean   → KEEP (counts/flags/totals are non-CUI structural);
 *     • anything else     → DROP (strings, nested objects → default-deny: could be CUI).
 *   This preserves `{count: 3, items: [{id, status}]}` while dropping any
 *   free-text wrapper field (e.g. semanticSearch's echoed `query`, or a
 *   complianceControls `summary` object).
 * - non-object/array (bare string/number) ⇒ FULL withhold.
 */
export function projectResult(value: unknown, entityType: string | undefined): unknown {
  if (!entityType) return WITHHELD;
  const fields = EXPOSABLE_FIELDS[entityType];
  if (!fields) return WITHHELD;

  if (Array.isArray(value)) {
    return value.map((el) => projectOne(el, fields));
  }
  if (value === null || typeof value !== "object") return WITHHELD;

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (Array.isArray(v)) {
      out[k] = v.map((el) => projectOne(el, fields));
    } else if (typeof v === "number" || typeof v === "boolean") {
      // counts / totals / flags — non-CUI structural metadata.
      out[k] = v;
    }
    // strings / nested objects (e.g. a free-text `query`, `summary` object) → DROP.
  }
  return out;
}
