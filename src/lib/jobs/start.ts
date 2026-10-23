import { appJobRunner, jobsEnabled } from "./runner";

const STARTED = Symbol.for("cosmos.jobs.started");
type Holder = { [STARTED]?: boolean };

/**
 * Start the app's periodic jobs, once per process (dev HMR re-runs
 * register(); this doesn't double-start). Stops cleanly on SIGTERM/SIGINT,
 * releasing each job's lock so another instance can lead at once.
 */
export async function startJobs(): Promise<void> {
  if (!jobsEnabled()) return;
  const g = globalThis as Holder;
  if (g[STARTED]) return;
  g[STARTED] = true;
  await import("./jobs");
  const runner = appJobRunner();
  runner.start();
  // Next's own server installs a SIGTERM handler that calls process.exit(143),
  // so this release can lose the race. That's harmless: a session advisory
  // lock dies with its connection, and the connection dies with the process.
  const stop = () => void runner.stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
