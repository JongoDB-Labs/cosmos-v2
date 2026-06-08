/**
 * Cross-project work-item query — public surface ("JQL-lite").
 *
 *   filter.ts      — the typed, serialisable filter model + constants
 *   build-where.ts — PURE Prisma where/orderBy builder (RBAC-scoped, unit-tested)
 *   scope.ts       — the one DB seam: which projects may the actor read
 *   parse.ts       — URL/JSON → validated filter + sort + pagination
 *   project.ts     — list-projection + the executor (no BigInt in the result)
 */
export * from "./filter";
export { buildWorkItemWhere, buildOrderBy } from "./build-where";
export type { BuildWhereArgs } from "./build-where";
export { getReadableProjectIds } from "./scope";
export {
  parseSearchParams,
  workItemFilterSchema,
  workItemQuerySchema,
  type ParsedQuery,
  type WorkItemQueryInput,
} from "./parse";
export {
  runWorkItemQuery,
  type IssueRow,
  type RunQueryArgs,
  type RunQueryResult,
} from "./project";
