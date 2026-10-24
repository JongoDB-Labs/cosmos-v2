/**
 * The background jobs as the instance admin's health readout shows them
 * (/api/v1/admin/updates/settings): is the runner on in this process, and if
 * not why, and for each job whether this instance leads it, when it last ran
 * and succeeded, and what its last failure was. So a stopped job is visible
 * without the host's logs.
 *
 * Timestamps, counts and an error's class only; the message is redacted
 * (redactMessage). It describes the instance that answered the request: with
 * several instances, another one may be leading a job this one isn't.
 */
import { appJobRunner, jobsDisabledReason, redactMessage, type JobStatus } from "./runner";

/** A run going this many times past its timeout hasn't stopped when asked: the job is stuck. */
const STUCK_FACTOR = 2;

export interface JobReport {
  name: string;
  leader: boolean;
  running: boolean;
  /** Running past its timeout without returning: every later tick skips it. */
  stuck: boolean;
  runningForSeconds: number | null;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  consecutiveFailures: number;
  lastErrorClass: string | null;
  lastErrorMessage: string | null;
  everySeconds: number;
}

export interface JobsReport {
  /** The runner runs jobs in this process. */
  enabled: boolean;
  /** Why it doesn't, when it doesn't. */
  reason: string | null;
  jobs: JobReport[];
}

export function describeJobs(
  input: { disabledReason: string | null; started: boolean; statuses: JobStatus[] },
  now: Date,
): JobsReport {
  const reason = input.disabledReason ?? (input.started ? null : "the runner wasn't started in this process (the server's startup hook didn't run it)");
  return {
    enabled: reason === null,
    reason,
    jobs: input.statuses.map((s) => {
      const runningFor = s.running && s.lastStartedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(s.lastStartedAt)) / 1000)) : null;
      return {
        name: s.name,
        leader: s.leader,
        running: s.running,
        stuck: runningFor !== null && runningFor * 1000 > s.timeoutMs * STUCK_FACTOR,
        runningForSeconds: runningFor,
        lastStartedAt: s.lastStartedAt,
        lastSucceededAt: s.lastSucceededAt,
        consecutiveFailures: s.consecutiveFailures,
        // A lock failure is the runner's own, and says which: keep its prefix.
        lastErrorClass: s.lastError?.startsWith("lock: ") ? "lock unavailable" : s.lastErrorClass,
        lastErrorMessage: redactMessage(s.lastError),
        everySeconds: Math.round(s.everyMs / 1000),
      };
    }),
  };
}

/**
 * This process's runner, now. Read only: the job list registers when the
 * startup hook imports it, so a runner that never started reports no jobs
 * rather than this registering them a second time from another bundle.
 */
export function jobsReport(now: Date = new Date()): JobsReport {
  const runner = appJobRunner();
  return describeJobs({ disabledReason: jobsDisabledReason(), started: runner.isStarted(), statuses: runner.status() }, now);
}
