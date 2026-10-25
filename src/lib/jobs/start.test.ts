// @vitest-environment node
//
// The regression that kept every job off in production: the standalone server
// (`node server.js`) leaves NEXT_RUNTIME unset at runtime, and the runner
// asked for it. instrumentation.ts gates the runtime; startJobs must start
// the runner without it.
import { describe, it, expect, vi, afterEach } from "vitest";

// The job list pulls in the whole app; this is about starting, not the jobs.
vi.mock("./jobs", () => ({}));

import { startJobs } from "./start";
import { appJobRunner } from "./runner";

const STARTED = Symbol.for("cosmos.jobs.started");

afterEach(async () => {
  await appJobRunner().stop();
  delete (globalThis as Record<symbol, unknown>)[STARTED];
  vi.unstubAllEnvs();
});

describe("startJobs", () => {
  it("starts the runner as the standalone server runs it: NEXT_RUNTIME unset", async () => {
    const runtime = process.env.NEXT_RUNTIME;
    delete process.env.NEXT_RUNTIME;
    try {
      vi.stubEnv("DATABASE_URL", "postgres://x");
      vi.stubEnv("JOBS_DISABLED", "");
      await startJobs();
      expect(appJobRunner().isStarted()).toBe(true);
    } finally {
      if (runtime !== undefined) process.env.NEXT_RUNTIME = runtime;
    }
  });

  it("starts nothing with JOBS_DISABLED", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("JOBS_DISABLED", "1");
    await startJobs();
    expect(appJobRunner().isStarted()).toBe(false);
  });
});
