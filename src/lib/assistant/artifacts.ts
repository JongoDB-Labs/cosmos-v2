/**
 * Chat artifacts — turning a mutating tool call into a linked entity card.
 *
 * Mirrors the v1 (okr-dashboard) `ToolCallBadge`, which mapped
 * `create_card`/`update_card`/`delete_card` tool calls to a label describing the
 * affected entity ("Created: <title>", "Updated card <id>"). We keep that
 * result→label idea but upgrade the badge into a real, clickable card that
 * deep-links to the entity's detail page (the app is route-based, unlike v1's
 * single board), reusing the shared `entityUrl` builder so a chat link is
 * byte-identical to an @-mention link.
 *
 * CUI-blind masking: the card is built from the tool call's USER-facing result
 * (the executor's full output, which already flows to the UI and is the same
 * data the "Tool result" panel shows) plus the arguments the invoking user
 * typed. It LINKS BY ID; the entity's own detail page enforces authorization and
 * classification on click. We surface only the entity's own title/name — never
 * another member's PII or a withheld field.
 *
 * PURE module (no server/client deps) so it is importable by the chat component
 * and unit-testable.
 */
import type { EntityType } from "@/lib/mentions/refs";
import { ENTITY_LABEL } from "@/lib/mentions/refs";
import { entityUrl } from "@/lib/mentions/urls";

export type ArtifactAction = "created" | "updated" | "deleted";

export interface ChatArtifact {
  /** The tool_use id this artifact came from (stable React key). */
  toolCallId: string;
  entityType: EntityType;
  action: ArtifactAction;
  /** The entity id (deep-link target). */
  id: string;
  /** Human display label (title/name, or an id fallback). */
  label: string;
  /** Singular entity-type label, e.g. "Work item". */
  typeLabel: string;
  /** Deep-link, or null when the entity has no linkable page (or was deleted). */
  url: string | null;
}

/**
 * Mutating tools that produce a chat artifact, mapped to the mentions
 * `EntityType` used for deep-linking. Only create/update/delete tools whose
 * entity has a detail surface are listed; read tools (list_ and query_ prefixes)
 * and non-navigable entities (cycles, comments, time entries) are intentionally
 * omitted so we don't spam cards for queries.
 */
const TOOL_ARTIFACT_TYPE: Record<string, EntityType> = {
  create_work_item: "workItem",
  update_work_item: "workItem",
  delete_work_item: "workItem",
  create_project: "project",
  update_project: "project",
  create_note: "note",
  update_note: "note",
  delete_note: "note",
  create_meeting: "meeting",
  update_meeting: "meeting",
  delete_meeting: "meeting",
  create_objective: "objective",
  update_objective: "objective",
  delete_objective: "objective",
  // key results live on the OKRs page — link there.
  create_key_result: "objective",
  update_key_result: "objective",
  create_milestone: "milestone",
  update_milestone: "milestone",
  delete_milestone: "milestone",
  create_goal: "goal",
  update_goal: "goal",
  create_kpi: "kpi",
  update_kpi: "kpi",
  create_risk: "risk",
  update_risk: "risk",
  create_blocker: "blocker",
  update_blocker: "blocker",
  create_deliverable: "deliverable",
  update_deliverable: "deliverable",
  create_change_request: "changeRequest",
  update_change_request: "changeRequest",
  create_crm_contact: "crmContact",
  update_crm_contact: "crmContact",
};

const ACTION_BY_VERB: Record<string, ArtifactAction> = {
  create: "created",
  update: "updated",
  delete: "deleted",
};

/** A tool call as it reaches the renderer (live, `done` event, or persisted). */
export interface ToolCallForArtifact {
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** First nested plain-object value (e.g. the `project`/`objective` the executor nests). */
function firstNestedEntity(result: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const v of Object.values(result)) {
    const rec = asRecord(v);
    if (rec) return rec;
  }
  return undefined;
}

/**
 * Map a single tool call to a linked artifact, or null when it is not a
 * mutating entity call, failed (no id / error result), or has an unknown type.
 */
export function toolCallToArtifact(
  tc: ToolCallForArtifact,
  opts: { orgSlug: string },
): ChatArtifact | null {
  const name = tc.name;
  if (!name) return null;
  const m = /^(create|update|delete)_(.+)$/.exec(name);
  if (!m) return null;
  const entityType = TOOL_ARTIFACT_TYPE[name];
  if (!entityType) return null;
  const action = ACTION_BY_VERB[m[1]];

  const result = asRecord(tc.result) ?? {};
  // A failed mutation (executor returned `{ error }`) produced no entity → no card.
  if (result.error !== undefined) return null;
  const args = asRecord(tc.arguments) ?? {};
  const nested = firstNestedEntity(result);

  // The entity id: the executor returns `id` at the top level on every
  // create/update/delete success; fall back to the id the user passed for updates.
  const id =
    str(result.id) ??
    str(args.id) ??
    str(args.itemId) ??
    str(args.workItemId) ??
    str(args.projectId) ??
    (nested ? str(nested.id) : undefined);
  if (!id) return null;

  const typeLabel = ENTITY_LABEL[entityType];

  // Display label: prefer a concrete title/name from the result, then the args
  // the user typed, then a nested entity's; fall back to a short id.
  const ticket = result.ticketNumber ?? nested?.ticketNumber;
  const title =
    str(result.title) ??
    str(result.name) ??
    str(args.title) ??
    str(args.name) ??
    (nested ? str(nested.title) ?? str(nested.name) : undefined);
  let label = title ?? `${typeLabel} ${id.slice(0, 8)}`;
  if (entityType === "workItem" && (typeof ticket === "number" || typeof ticket === "string")) {
    label = `#${ticket}${title ? ` ${title}` : ""}`;
  }

  // Project deep-links need the owning project's KEY. `create_project` carries it
  // in the args; project-scoped types (objective/milestone/…) only expose a
  // projectId, so their URL builder returns null and the card renders un-linked.
  const projectKey = str(args.key) ?? (nested ? str(nested.key) : undefined);

  // A deleted entity has no page to open → never link it.
  const url =
    action === "deleted" ? null : entityUrl(entityType, { orgSlug: opts.orgSlug, projectKey, id });

  return { toolCallId: str(tc.id) ?? id, entityType, action, id, label, typeLabel, url };
}

/** Map a list of tool calls to their artifacts (skipping non-artifact calls). */
export function artifactsFromToolCalls(
  tcs: readonly ToolCallForArtifact[] | undefined,
  opts: { orgSlug: string },
): ChatArtifact[] {
  if (!tcs || tcs.length === 0) return [];
  const out: ChatArtifact[] = [];
  for (const tc of tcs) {
    const a = toolCallToArtifact(tc, opts);
    if (a) out.push(a);
  }
  return out;
}
