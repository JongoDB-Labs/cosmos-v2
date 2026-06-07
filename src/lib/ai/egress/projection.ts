// src/lib/ai/egress/projection.ts
import type { ClassificationLevel } from "@prisma/client";
import { mintHandle } from "./handles";
import { connectorEgressMaps } from "../connectors";

// EXTERNAL connectors (github, …) contribute their egress mapping declaratively via
// the connector registry; we MERGE those contributions into the native static maps
// below so the global TOOL_ENTITY / EXPOSABLE_FIELDS / HANDLEABLE_FIELDS are byte-
// identical to the pre-registry literals — just sourced from one place each. Native
// (non-connector) cosmos entries stay hand-listed here (they are NOT connectors).
// Computed ONCE at module load (registry is populated by connectors/index.ts import).
const _connectorEgress = connectorEgressMaps();
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

/**
 * Structural, non-CUI fields per entity. NEVER add a free-text/content/money/PII
 * field here. NATIVE cosmos entries are listed inline; EXTERNAL connector entities
 * (e.g. github_issue/github_pull_request) are merged in from the registry below.
 */
const NATIVE_EXPOSABLE_FIELDS: Record<string, readonly string[]> = {
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
  // EXTERNAL connector entities (github_issue/github_pull_request — structural-only:
  // number/state/draft/timestamps, title/body WITHHELD) are merged in from the
  // connector registry (see github.descriptor.ts), not listed here.
  //
  // Intentionally NO entry (⇒ full withhold) for: finance/accounting (amounts +
  // client are sensitive), google email/doc/event/file/contact (bodies are the
  // worst CUI), generated briefs, fetch_url. Their commercial-unclassified case
  // still flows (the gate exposes BEFORE projection); their withheld case is total.
};

/**
 * NATIVE static entries merged with EXTERNAL connector contributions (registry).
 *
 * EXPORTED (read-only) so the cutover exposability-map snapshot/gate
 * (scripts/cutover/lib/exposability.ts) serializes the EXACT same merged map the
 * gate enforces — never a re-hardcoded copy that could drift. This is a pure
 * read of the already-computed constant; the gate/projection behavior is unchanged.
 */
export const EXPOSABLE_FIELDS: Record<string, readonly string[]> = {
  ...NATIVE_EXPOSABLE_FIELDS,
  ..._connectorEgress.exposableFields,
};

/**
 * HANDLEABLE_FIELDS — the per-entity allowlist of withheld CUI **string** fields
 * that may be surfaced to the CUI-blind model as an OPAQUE HANDLE (a token, never
 * the value) so the model can carry/route that value into a later tool call by
 * reference. This is ORTHOGONAL to EXPOSABLE_FIELDS (which is left UNCHANGED):
 * EXPOSABLE_FIELDS is the set of structural scalars the model may READ; a
 * HANDLEABLE field is content the model may NOT read but may REFERENCE.
 *
 * DEFAULT-DENY: a field is minted into a handle ONLY when (a) it is listed here for
 * the entity type AND (b) it is present as a NON-EMPTY STRING on the SOURCE entity.
 * Unknown entity types / non-entity results get NO handles (augmentWithHandles is a
 * no-op). Every field below is verified against the REAL executor return shapes
 * (src/lib/ai/executors/*.ts + tool-executor.ts) — only fields that actually appear
 * on a returned entity are listed (a listed-but-absent field simply never mints).
 *
 * ACCEPTED, DOCUMENTED TRADE (threat-model item 9): a handle reveals a CUI field's
 * PRESENCE / non-emptiness to the model (not its content) — a tiny metadata
 * increase over dropping it entirely, accepted for the act-by-reference capability.
 * It can be made opt-in per deployment later (the EGRESS_HANDLES_ENABLED flag in
 * the loop already gates the whole mechanism off).
 */
const NATIVE_HANDLEABLE_FIELDS: Record<string, readonly string[]> = {
  // work-items: create/update/list all return `title` (CUI). `description` is NOT
  // present on any work_item executor return shape today (input/embedding only),
  // so it is intentionally OMITTED — listing it would never mint (default-deny by
  // absence) and would misrepresent the shape contract.
  work_item: ["title"],
  // notes: create/update return `title` (CUI). `content` is NOT in the note return
  // shapes (only title + visibility), so it is omitted (default-deny by absence).
  note: ["title"],
  // comments: listComments returns full `content`; addComment returns a derived
  // `contentPreview` (a 200-char CUI slice). Both are referenceable content.
  comment: ["content", "contentPreview"],
  // crm: queryCrm returns full CrmContact rows → `name` (PII) + `notes` (content).
  crm_contact: ["name", "notes"],
  // semantic_search hits carry `title` + `snippet` (both derive CUI content).
  search_result: ["title", "snippet"],
  // No entry (⇒ no handles) for: project/cycle/time_entry/org_member/
  // compliance_control/github_* and all unmapped (finance/google/...) — either
  // their content fields aren't surfaced or referencing them isn't in scope yet.
  // EXTERNAL connectors may contribute handleable fields via the registry; they
  // are merged in below. (github contributes none today.)
};

/** NATIVE static entries merged with EXTERNAL connector contributions (registry). */
export const HANDLEABLE_FIELDS: Record<string, readonly string[]> = {
  ...NATIVE_HANDLEABLE_FIELDS,
  ..._connectorEgress.handleableFields,
};

const NATIVE_TOOL_ENTITY: Record<string, string> = {
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
  // EXTERNAL connector tools (github read-only → structural-only github_issue/
  // github_pull_request so a gov tenant sees number/state/timestamps, never
  // titles/bodies) are merged in from the registry (github.descriptor.ts).
  // No mapping ⇒ undefined ⇒ full withhold: query_finance, get_finance_summary,
  // log_revenue, log_expense, get_trial_balance, get_profit_and_loss,
  // generate_cycle_brief, fetch_url, process_transcript, and all google_* tools.
};

/**
 * NATIVE static entries merged with EXTERNAL connector contributions (registry).
 *
 * EXPORTED (read-only) for the cutover exposability-map snapshot/gate — see the
 * EXPOSABLE_FIELDS note above. `entityTypeForTool` remains the single-lookup
 * accessor used by the loop; the snapshot needs the WHOLE map, so the merged
 * constant is exported too (a pure read; no behavior change).
 */
export const TOOL_ENTITY: Record<string, string> = {
  ...NATIVE_TOOL_ENTITY,
  ..._connectorEgress.toolEntity,
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

/**
 * Mint opaque handles for the withheld CUI string fields of a SINGLE projected
 * entity, IN PLACE, against its matching source entity. Default-deny: only
 * `HANDLEABLE_FIELDS[entityType]` fields that are present as a NON-EMPTY STRING on
 * the source are minted; the projected (structural) fields are untouched — we only
 * ADD handle tokens. Returns the count of handles minted.
 */
async function augmentOneEntity(
  projected: unknown,
  source: unknown,
  fields: readonly string[],
  entityType: string,
  conversationId: string,
  ceiling: ClassificationLevel,
): Promise<number> {
  // We can only attach handles to a projected OBJECT entity matched to a source
  // OBJECT entity. (projectOne yields WITHHELD for non-objects → nothing to augment.)
  if (projected === null || typeof projected !== "object" || Array.isArray(projected)) return 0;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return 0;
  const proj = projected as Record<string, unknown>;
  const src = source as Record<string, unknown>;
  let minted = 0;
  for (const field of fields) {
    const v = src[field];
    if (typeof v !== "string" || v.length === 0) continue; // present, non-empty STRING only
    // C1: bind the WITHHOLD ceiling to the handle so resolving it later forces the
    // resolving turn's result to re-gate at ≥ this ceiling (mint-ceiling binding).
    proj[field] = await mintHandle(conversationId, v, { entityType, fieldName: field }, ceiling);
    minted++;
  }
  return minted;
}

/**
 * augmentWithHandles — the MINT side of the opaque-handle resolver.
 *
 * Takes the already-projected, model-safe structural `modelView` (the output of
 * {@link projectResult}) plus the ORIGINAL `sourceOutput` the executor returned,
 * and ADDS an opaque handle TOKEN for each withheld CUI string field listed in
 * `HANDLEABLE_FIELDS[entityType]` that is present on the matching source entity.
 * The model then sees the structural fields (as before) PLUS a token standing in
 * for each handleable CUI field — letting it reference (move/file/route) a value it
 * cannot read.
 *
 * MATCHING: it mirrors `projectResult`'s unwrapping EXACTLY so projected elements
 * line up with their source elements by index:
 *   - unknown entityType / no HANDLEABLE_FIELDS / non-entity (WITHHELD) view ⇒
 *     no-op (returns the view unchanged, 0 minted) — default-deny.
 *   - bare array view  ⇒ element i ↔ sourceArray[i].
 *   - object wrapper   ⇒ for each top-level key whose model-view value is an ARRAY
 *     (the entity collection projectResult kept), element i ↔ source[key][i].
 *     Wrapper scalars (count/flags) carry no handleable content → skipped.
 *
 * `ceiling` is the WITHHOLD ceiling of THIS result (resolved by the loop). It is
 * bound to every minted handle (C1) so resolving a handle later forces the resolving
 * turn's result to re-gate at ≥ this ceiling.
 *
 * Returns the (mutated) model view and the total handle count for the AC-4 audit.
 * NOTE: mutates the modelView in place (it is freshly built by projectResult each
 * turn and not shared) — the source output is never mutated.
 */
export async function augmentWithHandles(
  modelView: unknown,
  sourceOutput: unknown,
  entityType: string | undefined,
  conversationId: string,
  ceiling: ClassificationLevel,
): Promise<{ modelView: unknown; minted: number }> {
  if (!entityType) return { modelView, minted: 0 };
  const fields = HANDLEABLE_FIELDS[entityType];
  if (!fields || fields.length === 0) return { modelView, minted: 0 };
  // A fully-withheld (non-entity) view has nothing structural to augment.
  if (modelView === null || typeof modelView !== "object") return { modelView, minted: 0 };

  let minted = 0;

  // Bare array view ↔ bare source array (projectResult mapped element-wise).
  if (Array.isArray(modelView)) {
    if (!Array.isArray(sourceOutput)) return { modelView, minted: 0 };
    for (let i = 0; i < modelView.length; i++) {
      minted += await augmentOneEntity(modelView[i], sourceOutput[i], fields, entityType, conversationId, ceiling);
    }
    return { modelView, minted };
  }

  // Object wrapper: for each key whose model-view value is an array (the projected
  // entity collection), match element-wise against the same key in the source.
  if (sourceOutput === null || typeof sourceOutput !== "object" || Array.isArray(sourceOutput)) {
    return { modelView, minted: 0 };
  }
  const view = modelView as Record<string, unknown>;
  const src = sourceOutput as Record<string, unknown>;
  for (const [key, projVal] of Object.entries(view)) {
    if (!Array.isArray(projVal)) continue; // wrapper scalars (count/flags) — no content
    const srcVal = src[key];
    if (!Array.isArray(srcVal)) continue; // shape changed under us → skip (default-deny)
    for (let i = 0; i < projVal.length; i++) {
      minted += await augmentOneEntity(projVal[i], srcVal[i], fields, entityType, conversationId, ceiling);
    }
  }
  return { modelView, minted };
}
