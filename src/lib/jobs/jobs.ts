/**
 * Every periodic job the app runs, registered on the shared runner
 * (src/lib/jobs/runner.ts). Add one with registerJob({ name, everyMs, run }):
 * the run must be idempotent, since a leader change can repeat a run.
 */
export {};
