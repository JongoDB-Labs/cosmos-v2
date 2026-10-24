import { describe, it, expect } from "vitest";
import { describeJobs } from "./report";
import type { JobStatus } from "./runner";

const NOW = new Date("2026-10-24T23:30:00.000Z");
const job = (over: Partial<JobStatus> = {}): JobStatus => ({
  name: "outbox-worker", leader: true, running: false, lastStartedAt: "2026-10-24T23:29:59.000Z", lastFinishedAt: "2026-10-24T23:29:59.500Z",
  lastOk: true, lastSucceededAt: "2026-10-24T23:29:59.500Z", lastError: null, lastErrorClass: null, consecutiveFailures: 0, nextRunAt: null,
  everyMs: 1000, timeoutMs: 30_000, ...over,
});

describe("describeJobs", () => {
  it("says the runner is off, and why", () => {
    expect(describeJobs({ disabledReason: "JOBS_DISABLED", started: false, statuses: [] }, NOW)).toEqual({ enabled: false, reason: "JOBS_DISABLED", jobs: [] });
    // On by its env, but nothing started it: what production looked like before the fix.
    expect(describeJobs({ disabledReason: null, started: false, statuses: [] }, NOW)).toMatchObject({ enabled: false, reason: expect.stringMatching(/wasn't started/) });
    expect(describeJobs({ disabledReason: null, started: true, statuses: [job()] }, NOW)).toMatchObject({ enabled: true, reason: null });
  });

  it("calls a run going twice past its timeout stuck, and a slow one only running", () => {
    const [stuck, slow] = describeJobs(
      {
        disabledReason: null,
        started: true,
        statuses: [job({ running: true, lastStartedAt: "2026-10-24T20:30:00.000Z" }), job({ name: "slow", running: true, lastStartedAt: "2026-10-24T23:29:10.000Z" })],
      },
      NOW,
    ).jobs;
    expect(stuck).toMatchObject({ stuck: true, runningForSeconds: 3 * 3600 });
    expect(slow).toMatchObject({ stuck: false, running: true, runningForSeconds: 50 });
  });

  it("gives a failure's class and a redacted message, and names a lock failure as one", () => {
    const [failing, lock] = describeJobs(
      {
        disabledReason: null,
        started: true,
        statuses: [
          job({ consecutiveFailures: 3, lastOk: false, lastError: 'relation "domain_events" does not exist', lastErrorClass: "PrismaClientKnownRequestError P2010" }),
          job({ name: "teams-outbox", leader: false, lastError: "lock: connect ECONNREFUSED 10.0.0.5:5432", lastErrorClass: null }),
        ],
      },
      NOW,
    ).jobs;
    expect(failing).toMatchObject({ consecutiveFailures: 3, lastErrorClass: "PrismaClientKnownRequestError P2010", lastErrorMessage: "relation <value> does not exist" });
    expect(lock).toMatchObject({ leader: false, lastErrorClass: "lock unavailable", lastErrorMessage: "lock: connect ECONNREFUSED <address>" });
  });
});
