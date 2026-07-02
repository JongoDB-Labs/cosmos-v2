import { notifyError } from "@/lib/errors/notify";

/**
 * Apply an operation to many ids concurrently (bulk edit/delete on the PM
 * registers). Reuses each entity's existing single-row PATCH/DELETE route, so no
 * dedicated bulk endpoint is needed. Reports a partial-failure toast; returns
 * the counts so the caller can refetch + clear selection.
 */
export async function bulkFanOut(
  ids: string[],
  op: (id: string) => Promise<unknown>,
  failLabel = "Some rows couldn't be updated.",
): Promise<{ ok: number; failed: number }> {
  const results = await Promise.allSettled(ids.map((id) => op(id)));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    const firstErr = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    notifyError(
      firstErr?.reason instanceof Error ? firstErr.reason : new Error(failLabel),
      `${failLabel} (${failed} of ${ids.length} failed)`,
    );
  }
  return { ok: ids.length - failed, failed };
}
