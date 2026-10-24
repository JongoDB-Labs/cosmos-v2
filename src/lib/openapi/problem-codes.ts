/** Problem `code` → `title`. Pure, for contract schemas; see ./problem.ts. */
export const PROBLEM_CODES = {
  invalid_request: "Invalid request",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  insufficient_scope: "Insufficient scope",
  not_found: "Not found",
  conflict: "Conflict",
  model_not_connected: "Claude isn't connected",
  rate_limited: "Too many requests",
  internal_error: "Internal server error",
  // A status change the project's workflow refused (src/lib/workflow/contract.ts).
  transition_not_allowed: "Transition not allowed",
  transition_ambiguous: "Transition ambiguous",
  transition_forbidden: "Transition not permitted",
  transition_invalid: "Transition checks failed",
  transition_input_required: "Transition needs input",
  type_change_needs_status: "New type needs a status",
  // An assignee who isn't a member of the item's org; the same answer whether
  // or not the user exists (src/lib/work-items/apply-change.server.ts).
  assignee_not_in_org: "Assignee not in this organization",
  // An edit to a workflow refused (src/lib/workflow/contract.ts WorkflowEditError).
  workflow_invalid: "Workflow has errors",
  migration_map_required: "Items need a new status",
  workflow_in_use: "Workflow in use",
  // An automation rule that names what its project or org doesn't have (src/lib/automation/rules.server.ts).
  automation_invalid: "Automation rule has errors",
} as const;

export type ProblemCode = keyof typeof PROBLEM_CODES;
