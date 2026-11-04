/**
 * The closing rule: an org (or one project) can require that a work item
 * can't close without evidence, and is read-only once closed.
 *
 *   - EVIDENCE: moving an item into a Done status needs a supporting file
 *     attached to it, or a recorded reason one isn't needed
 *     (WorkItem.closeEvidenceNote). Without either, the move asks for the
 *     reason through the ordinary transition dialog — the same mechanism a
 *     resolution or a cancel note uses, so every surface (board, detail
 *     panel, bulk, assistant) gets it without a UI of its own.
 *   - READ-ONLY: an item in a Done status can't be edited. Reopening it —
 *     moving it to a status that isn't Done — is the way back, and is itself
 *     recorded in the item's history.
 *
 * Both apply to people's changes, like every workflow input and field rule;
 * a system change (a merge, a migration) is held to the workflow's structure
 * only.
 *
 * Org default on Organization.settings.workflow.closingRule (off unless set).
 * A project may override it either way with Project.settings.closingRule.
 *
 * Client-safe: no server imports.
 */

export const CLOSE_EVIDENCE_LABEL = "Why no supporting file is needed";

export const CLOSED_READ_ONLY_MESSAGE = "This item is closed and read-only. Reopen it to change it.";

/** The project's own choice wins; otherwise the org's; otherwise off. */
export function closingRuleOn(orgClosingRule: boolean, projectSettings: unknown): boolean {
  const own = (projectSettings as { closingRule?: unknown } | null | undefined)?.closingRule;
  return typeof own === "boolean" ? own : orgClosingRule;
}
