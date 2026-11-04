/**
 * The closing rule for deliverables and phases — the same rule work items
 * follow (src/lib/workflow/closing-rule.ts), on the records that close outside
 * the workflow engine.
 *
 *   - EVIDENCE: closing needs a supporting file attached to the record
 *     (Document.deliverableId / phaseId), or a recorded reason one isn't
 *     needed (closeEvidenceNote). Refused with `close_evidence_required`, so a
 *     client can ask for the reason and retry.
 *   - READ-ONLY: a closed record can't be edited, deleted, or have its files
 *     taken off it (`closed_read_only`) until it is reopened.
 *
 * A deliverable is closed when its status is ACCEPTED or ACCEPTED_WITH_COMMENTS.
 * A phase is closed when it has a closedAt, set only by the explicit Close
 * action: 100% complete is not the same as accepted.
 *
 * The same switch as work items: the org's workflow.closingRule, overridden
 * per project by Project.settings.closingRule.
 *
 * Client-safe: no server imports.
 */

export const CLOSED_DELIVERABLE_STATUSES: readonly string[] = ["ACCEPTED", "ACCEPTED_WITH_COMMENTS"];

const CLOSE_EVIDENCE_REQUIRED_MESSAGE =
  "Attach a supporting file, or record why one isn't needed, before closing this.";
export const CLOSED_RECORD_READ_ONLY_MESSAGE = "This is closed and read-only. Reopen it to change it.";

export type ClosingRefusal = { code: "close_evidence_required" | "closed_read_only"; message: string };

/**
 * What the closing rule says about one change to a deliverable or phase.
 *
 * `edits` is whether the change touches anything other than reopening it: a
 * closed record may only be reopened. `note` is the reason as it will be after
 * the change (the request's, else the one already recorded).
 */
export function closingDecision(args: {
  ruleOn: boolean;
  wasClosed: boolean;
  willBeClosed: boolean;
  edits: boolean;
  files: number;
  note: string | null | undefined;
}): ClosingRefusal | null {
  if (!args.ruleOn) return null;
  if (args.wasClosed) {
    // Staying closed while changing something is an edit to a closed record.
    if (args.willBeClosed && args.edits) return { code: "closed_read_only", message: CLOSED_RECORD_READ_ONLY_MESSAGE };
    return null;
  }
  if (args.willBeClosed && args.files === 0 && !args.note?.trim()) {
    return { code: "close_evidence_required", message: CLOSE_EVIDENCE_REQUIRED_MESSAGE };
  }
  return null;
}
