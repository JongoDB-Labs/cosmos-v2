/**
 * What the transition endpoints say to a client: the transitions an actor may
 * take from an item's status, and why a status change was refused.
 *
 * Refusals keep the API's error shape, `{ error: string }`, which every client
 * already reads, and add the structure beside it: a `code` to branch on and,
 * for missing input, the fields to ask for. A UI that sees
 * `transition_input_required` opens the transition dialog with `fields` and
 * retries with `transition.input`; anything older shows `error` and moves on.
 */
import type { FieldRef } from "@/lib/workflow/definition";

export type TransitionErrorCode =
  | "transition_not_allowed"
  | "transition_ambiguous"
  | "transition_forbidden"
  | "transition_invalid"
  | "transition_input_required"
  | "type_change_needs_status";

export interface TransitionInputField {
  field: FieldRef;
  required: boolean;
  label?: string;
  /** For a choice field: the values to offer. */
  options?: { value: string; label: string; hint?: string }[];
}

export interface AvailableTransition {
  id: string;
  name: string;
  to: string;
  toCategory: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";
  /** Fields the transition asks for; empty when a click is enough. */
  input: TransitionInputField[];
}

export interface TransitionErrorBody {
  error: string;
  code: TransitionErrorCode;
  transition?: { id: string; name: string; to: string };
  /** transition_input_required: what to ask for. */
  fields?: TransitionInputField[];
  /** transition_invalid: each failed check. */
  reasons?: { validator: string; message: string; fields?: FieldRef[] }[];
  /** transition_ambiguous: the transitions to choose between. */
  candidates?: { id: string; name: string }[];
  /** type_change_needs_status: the statuses the new type's workflow has. */
  statuses?: string[];
}

const STATUS: Record<TransitionErrorCode, number> = {
  transition_not_allowed: 409,
  transition_ambiguous: 409,
  transition_forbidden: 403,
  transition_invalid: 422,
  transition_input_required: 422,
  type_change_needs_status: 409,
};

/** Thrown inside a change; `handleApiError` turns it into the response. */
export class TransitionError extends Error {
  readonly status: number;
  constructor(readonly body: TransitionErrorBody) {
    super(body.error);
    this.name = "TransitionError";
    this.status = STATUS[body.code];
  }
}

/** Narrow an unknown response body to a transition refusal. */
export function asTransitionError(body: unknown): TransitionErrorBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<TransitionErrorBody>;
  return typeof b.error === "string" && typeof b.code === "string" && b.code in STATUS ? (b as TransitionErrorBody) : null;
}

/** One item a bulk change left alone, with why; for missing input, what to ask for. */
export interface BulkDenial {
  id: string;
  code: TransitionErrorCode;
  message: string;
  transition?: { id: string; name: string; to: string };
  fields?: TransitionInputField[];
}

export type WorkflowEditErrorCode = "workflow_invalid" | "migration_map_required" | "workflow_in_use" | "automation_invalid";

const EDIT_STATUS: Record<WorkflowEditErrorCode, number> = {
  workflow_invalid: 422,
  migration_map_required: 409,
  workflow_in_use: 409,
  automation_invalid: 422,
};

/**
 * A workflow edit refused: a draft with errors, statuses that still hold items
 * and need a new one, a workflow something still uses, or an automation rule
 * that names things its project or org doesn't have. `extensions` go
 * beside the problem's fields (the issues, the statuses to map).
 */
export class WorkflowEditError extends Error {
  readonly status: number;
  constructor(
    readonly code: WorkflowEditErrorCode,
    message: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkflowEditError";
    this.status = EDIT_STATUS[code];
  }
}
