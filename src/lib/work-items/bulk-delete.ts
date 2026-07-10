/**
 * Summarise the outcome of a bulk work-item delete that fans out one request
 * per project.
 *
 * The Issues view can select items across several projects, so a bulk delete is
 * issued as one request per project (see `bucketByProject`). Those requests are
 * awaited with `Promise.allSettled` so one project failing never aborts the
 * others — otherwise a partial failure would leave some items deleted, some not,
 * the selection uncleared, and the user staring at a generic
 * "Couldn't delete the selected items." with no idea what actually happened
 * (COSMOS-76).
 *
 * This resolver folds the per-project results into a single view:
 *   - how many items were actually deleted,
 *   - which ids belong to a FAILED group (kept selected so the user can retry),
 *   - a specific, human error message naming how many items in which project
 *     failed and why — or `null` when everything succeeded.
 */

export interface BulkDeleteGroupResult {
  projectId: string;
  /** Human label for the project (its key/name) when known, else undefined. */
  projectLabel?: string;
  /** The ids that were sent in this project's request. */
  ids: string[];
  /** Whether the project's bulk-delete request succeeded. */
  ok: boolean;
  /** Server/error reason when `!ok` (e.g. a FetchError message). */
  reason?: string;
}

export interface BulkDeleteSummary {
  /** Number of items in groups that succeeded. */
  deleted: number;
  /** Ids whose group failed — keep them selected so the user can retry. */
  failedIds: string[];
  /** Null when everything succeeded; else a specific message (who + why). */
  errorMessage: string | null;
}

const issues = (n: number) => `${n} issue${n === 1 ? "" : "s"}`;

export function summarizeBulkDelete(
  groups: BulkDeleteGroupResult[],
): BulkDeleteSummary {
  let deleted = 0;
  const failedIds: string[] = [];
  const reasons: string[] = [];

  for (const g of groups) {
    if (g.ok) {
      deleted += g.ids.length;
      continue;
    }
    failedIds.push(...g.ids);
    const label = g.projectLabel?.trim();
    const reason = g.reason?.trim() || "an unexpected error";
    reasons.push(label ? `${label}: ${reason}` : reason);
  }

  const failed = failedIds.length;
  if (failed === 0) {
    return { deleted, failedIds, errorMessage: null };
  }

  const detail = reasons.join("; ");
  const errorMessage =
    deleted === 0
      ? `Couldn't delete ${issues(failed)}: ${detail}.`
      : `Deleted ${issues(deleted)} of ${deleted + failed}. Couldn't delete ${failed}: ${detail}.`;

  return { deleted, failedIds, errorMessage };
}
