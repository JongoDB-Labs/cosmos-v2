import { registerJob } from "./runner";
import { runCalendarPulls } from "@/lib/integrations/microsoft/calendar-sync.server";

/**
 * Every periodic job the app runs, registered on the shared runner
 * (src/lib/jobs/runner.ts). Add one with registerJob({ name, everyMs, run }):
 * the run must be idempotent, since a leader change can repeat a run.
 */

// COSMOS-202 B2: bring Outlook edits back into Cosmos for everyone connected.
registerJob({
  name: "outlook-calendar-pull",
  everyMs: 5 * 60_000,
  jitterMs: 30_000,
  timeoutMs: 4 * 60_000,
  run: async ({ signal }) => {
    const r = await runCalendarPulls({ signal });
    return r.people || r.throttled || r.failed ? { ...r } : undefined;
  },
});
