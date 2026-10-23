/**
 * Every periodic job the app runs, registered on the shared runner
 * (src/lib/jobs/runner.ts). Add one with registerJob({ name, everyMs, run }):
 * the run must be idempotent, since a leader change can repeat a run.
 */
import { registerJob } from "./runner";
import { runDueSubscriptions } from "@/lib/query/subscriptions.server";

// CQL phase 6: emailed saved filters. Due rows are claimed with SKIP LOCKED and
// their next run moved on before sending, so a repeated run sends nothing twice.
registerJob({
  name: "filter-subscriptions",
  everyMs: 5 * 60_000,
  jitterMs: 30_000,
  timeoutMs: 4 * 60_000,
  run: async ({ signal }) => {
    const r = await runDueSubscriptions({ signal });
    return r.subscriptions ? { ...r } : undefined;
  },
});
