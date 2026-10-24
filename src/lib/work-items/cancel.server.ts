/**
 * Compatibility for the composed plugins, which may import the old name.
 *
 * Statuses are project rows now, so "the Cancelled column" is the project's
 * Cancelled status (created on first use, with a column on each status board).
 */
import { ensureCancelledStatus } from "@/lib/workflow/statuses.server";

/** @deprecated Use ensureCancelledStatus from `@/lib/workflow/statuses.server`. */
export const ensureCancelledColumn = ensureCancelledStatus;
