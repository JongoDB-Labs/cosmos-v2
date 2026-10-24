import type { z } from "zod";
import type { ApiKeyScope } from "@/lib/auth/api-key-scopes";

/**
 * A route's public contract: the ONE place its request and response shapes are
 * written. The handler imports these same schemas (`parseRequest`/`respond` in
 * ./respond.ts), and scripts/openapi builds the published spec from them, so
 * the two cannot drift.
 *
 * Contract files (`route.contract.ts`, beside the `route.ts` they describe)
 * stay pure: zod and lib/openapi only, no prisma, no next. The spec build runs
 * them in plain node, and coverage.arch.test.ts enforces the rule.
 */

/** `internal` routes are left out of the public spec and carry no promise. */
export type Stability = "stable" | "beta" | "internal";

export type ApiScope = ApiKeyScope;

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** Problem statuses an operation can answer with (each documented as a Problem). */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429;

export type AnyObject = z.ZodObject<z.ZodRawShape>;

export interface RouteContract<
  P extends AnyObject | undefined = AnyObject | undefined,
  Q extends AnyObject | undefined = AnyObject | undefined,
  B extends z.ZodType | undefined = z.ZodType | undefined,
  R extends Partial<Record<200 | 201 | 202, z.ZodType>> & { 204?: null } = Partial<
    Record<200 | 201 | 202, z.ZodType>
  > & { 204?: null },
> {
  method: HttpMethod;
  /** OpenAPI-style, relative to /api/v1: `/orgs/{orgId}/projects`. */
  path: `/${string}`;
  operationId: string;
  summary: string;
  description?: string;
  /** Reference-sidebar group, e.g. "Projects". */
  tags: [string, ...string[]];
  stability: Stability;
  /**
   * Scopes a bearer token must ALL hold. Documented in the spec as
   * `x-cosmos-scopes` and asserted before the handler's permission check.
   * Empty means NO token: an API key is refused (default-deny), and only a
   * browser session gets through. Every stable/beta contract names at least one
   * (coverage.arch.test.ts). A scope is a ceiling, never a grant: the user's
   * own permissions still apply.
   */
  scopes: ApiScope[];
  request: { params?: P; query?: Q; body?: B };
  responses: R;
  errors: ErrorStatus[];
  /** Lists only: `limit`/`cursor` query params plus `Link: rel="next"`. */
  pagination?: "cursor";
  /**
   * Fields an API token receives only when it holds `scope`; a browser session
   * always gets them. For personal data a token should be granted explicitly
   * (email addresses). Each path is EXACT, from the response root: dotted keys,
   * `[]` for every element of an array (`[].user.email`,
   * `members[].orgMember.user.email`), so an unrelated field that happens to
   * share the name is never touched. The schema marks each such field optional.
   */
  scopedFields?: { scope: ApiScope; paths: string[] }[];
  /**
   * Accepts `Idempotency-Key` (POSTs that create something): a retry with the
   * same key and body replays the first success instead of doing it twice.
   * The handler runs its work inside `idempotent()` (./idempotency.ts).
   */
  idempotency?: true;
}

/** Identity at runtime; exists for inference, so `parseRequest` and
 *  `respond` see each contract's exact schemas (and its `pagination`). */
export function defineRoute<const C extends RouteContract>(contract: C): C {
  return contract;
}

export function isRouteContract(v: unknown): v is RouteContract {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<RouteContract>;
  return typeof c.operationId === "string" && typeof c.method === "string" && typeof c.path === "string"
    && !!c.responses && !!c.request;
}
