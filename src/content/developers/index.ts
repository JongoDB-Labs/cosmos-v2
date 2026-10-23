import type { Guide } from "./types";
import { guide as quickstart } from "./quickstart";
import { guide as authentication } from "./authentication";
import { guide as errors } from "./errors";
import { guide as pagination } from "./pagination";
import { guide as rateLimits } from "./rate-limits";
import { guide as idempotency } from "./idempotency";
import { guide as versioning } from "./versioning";
import { guide as importingItems } from "./importing-items";

export type { Guide } from "./types";

/**
 * The guides, in reading order. Each is a TS module rather than a .md file so
 * it bundles with no loader and can compute the parts that must not drift
 * from the code (the scope table, error codes, rate budgets) from the code.
 */
export const GUIDES: Guide[] = [
  quickstart, authentication, errors, pagination, rateLimits, idempotency, versioning, importingItems,
];

export function guideBySlug(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}
