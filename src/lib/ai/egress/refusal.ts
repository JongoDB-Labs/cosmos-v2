// src/lib/ai/egress/refusal.ts
/**
 * A tool's REFUSAL, as the model reads it when the tool's result is withheld.
 *
 * `projectResult` keeps only the allowlisted scalars of a withheld result, and
 * drops every top-level string. A refusal is a top-level string: executors
 * answer `{ error: "Project not found" }`. So on a withheld result (every
 * result on a gov tenant, and any at or above FOUO) the model was handed `{}`,
 * or the full-withhold sentinel for an unmapped tool, and nothing said the
 * call had been refused. It then supplied a reason of its own, as models do
 * when a failure states no cause.
 *
 * The executor's text cannot simply be let through, because some refusals are
 * built from data: a shared service's error message (a board column's key, a
 * query's values), a connector's HTTP body, an id or key quoted back from the
 * arguments, and an argument can be a resolved handle, i.e. a value the model
 * was never cleared to read. On a withheld result that is exactly what must
 * not reach the model.
 *
 * So the model is only ever handed text written in server code, never a
 * string that came out of a row or a request:
 *  - a refusal whose text is in VERBATIM_REFUSALS, as it is. Each entry is a
 *    constant with nothing interpolated into it, so it cannot carry a title, a
 *    name or a body, whatever the result's classification.
 *    `refusal.arch.test.ts` keeps the list equal to the constant refusals the
 *    executors actually return.
 *  - this tool's own internal-failure answer (`toolFailureResult` in
 *    tool-executor.ts), as it is. It quotes only the tool's name, which is the
 *    call's own.
 *  - a schema rejection ("Invalid input: ..."), as INVALID_INPUT_REFUSAL. Its
 *    detail can quote the arguments.
 *  - anything else, as REASON_WITHHELD_REFUSAL.
 *
 * Only a result that is a refusal and nothing else is read this way: an
 * `error`, and at most a rejected query's `diagnostics` (dropped). A record
 * that merely has an `error` field among others is projected like any other.
 */

/**
 * Refusals the model may read word for word on a withheld result. Constants
 * only: never add a text built at run time, and never one quoting a value.
 */
export const VERBATIM_REFUSALS: ReadonlySet<string> = new Set([
  "A work item cannot link to itself",
  "Access denied by policy",
  "Blocker not found",
  "Both items must be in this project",
  "Change request not found",
  "Changing a feedback item's status is an admin action. You can file feedback and read it, but triaging somebody's report needs org-settings permission.",
  "Comment not found",
  "Contact not found",
  "Deliverable not found",
  "Feedback item not found",
  "Goal not found",
  "Insufficient permissions",
  "Interval not found",
  "Inviting someone to an event needs the user's yes: call share_calendar_event with this eventId and the people to add. Nothing was changed.",
  "Jira is connected but no site base URL is configured (e.g. https://acme.atlassian.net). Ask an admin to set it on the Integrations page.",
  "KPI not found",
  "Key result not found",
  "Letting more people see a note needs the user's yes: call share_note with this noteId and visibility. Nothing was changed.",
  "Link not found",
  "Meeting not found",
  "Milestone not found",
  "No active interval found",
  "Not a member of this organization",
  "Note not found",
  "Nothing to change: give a new name or a query.",
  "Objective not found",
  "Only active intervals can be completed",
  "Only the author can change who sees this note",
  "Only the author can update this note",
  "Only the author or an admin can delete this comment",
  "Only the author or an admin can delete this note",
  "Organization not found",
  "Project key already exists",
  "Project not found",
  "Risk not found",
  "Subject not found",
  "Team not found",
  "That assigneeId is not a member of this organization. Look the person up with list_org_members.",
  "That objective doesn't depend on the other one.",
  "That person is not a member of this organization. Look them up with list_org_members.",
  "That person is not a member of this project. Add them with add_project_member first.",
  "That person isn't a member of this organization.",
  "That transition isn't available.",
  "The query language is not switched on for this organization. Use list_work_items instead.",
  "The unified-connector engine (Nango) is not configured for this deployment.",
  "These items are already linked with that relationship.",
  "This connector (Nango unified-API breadth) is commercial-only and is not available to this tenant.",
  "This feedback was merged into another item; its status can't be changed until the merge is undone.",
  "This link would create a circular dependency — the two items would each depend on the other.",
  "Work item not found",
  "Work item not in this project",
  "You do not have permission to change this project",
  "You must be a project manager or an org admin to change its teams.",
  "attendees is required: the email addresses to invite",
  "channel is required (none provided and the Slack integration has no defaultChannel configured).",
  "endpoint is required (the provider-relative API path, e.g. '/v3/objects/contacts').",
  "eventId is required",
  "fileId is required",
  "issueKey (e.g. 'ABC-123') is required",
  "issueType is required (e.g. 'Task')",
  "itemId is required",
  "messageId is required",
  "name is required",
  "number (a positive issue number) is required",
  "owner and repo are required (none provided and the GitHub integration has no defaultOwner/defaultRepo configured).",
  "projectKey is required (none provided and the Jira integration has no defaultProjectKey configured).",
  "provider is required (the Nango integration id, e.g. 'hubspot').",
  "query is required",
  "summary is required",
  "summary, start, and end are required",
  "text is required",
  "to, subject, and body are required",
  "userId is required (use m365_list_users to find one)",
]);

/** What the model reads for a schema rejection on a withheld result. */
export const INVALID_INPUT_REFUSAL =
  "Invalid input: the arguments did not match this tool's input schema. The details are withheld here, because they can " +
  "quote the arguments. Check each argument against the schema and try again.";

/** What the model reads for any other refusal on a withheld result. */
export const REASON_WITHHELD_REFUSAL =
  "This tool refused the call or could not complete it. Its reason is withheld here, because it can quote data this " +
  "conversation is not cleared to see. Do not guess at a reason, and do not tell the user the record does not exist. " +
  "Check the arguments you sent; if they are right, tell the user it could not be done here and that the reason can't " +
  "be shown in this chat.";

/**
 * A tool that threw. The cause is unknown to the tool, so the text says it is
 * internal and forbids guessing one (an unexplained failure was once reported
 * to a user as a limit their request had broken, quoted from the tool's own
 * description). Built here so the egress projection can recognise it.
 */
export function internalFailureRefusal(toolName: string): string {
  return (
    `The ${toolName} tool failed for an internal reason. This is NOT caused by anything ` +
    `in the request, so do not guess at a cause and do not suggest the user change, ` +
    `shorten or simplify what they asked for. Tell them it couldn't be completed and ` +
    `that they can try again.`
  );
}

/** A tool whose query was refused by the database for an id that isn't one. */
export function badIdRefusal(toolName: string): string {
  return `The ${toolName} tool was called with an id that isn't a valid record id. Look the record up by name first and retry with the id it returns.`;
}

/**
 * The model's view of a withheld result that is a refusal, or `null` when the
 * result is not one. See the module comment for what may pass.
 */
export function refusalForModel(value: unknown, toolName?: string): { error: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;
  if (typeof src.error !== "string") return null;
  if (Object.keys(src).some((k) => k !== "error" && k !== "diagnostics")) return null;
  const text = src.error;
  if (VERBATIM_REFUSALS.has(text)) return { error: text };
  if (toolName !== undefined && (text === internalFailureRefusal(toolName) || text === badIdRefusal(toolName))) {
    return { error: text };
  }
  if (text.startsWith("Invalid input:")) return { error: INVALID_INPUT_REFUSAL };
  return { error: REASON_WITHHELD_REFUSAL };
}
