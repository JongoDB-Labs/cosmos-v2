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
  idempotency_key_reused: "Idempotency key reused",
  unsupported_api_version: "Unsupported API version",
  internal_error: "Internal server error",
} as const;

export type ProblemCode = keyof typeof PROBLEM_CODES;
