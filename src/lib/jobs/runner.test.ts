// The shared job runner: one leader per job across instances (a real Postgres
// advisory lock), failures isolated per job with capped exponential backoff,
// and a kill switch. Ticks are driven directly, so nothing here waits on timers.
import { describe, it, expect, afterEach } from "vitest";
import { JOBS_LOCK_NAMESPACE, JobRunner, errorClass, jobsDisabledReason, jobsEnabled, pgJobLock, redactMessage, type JobLock } from "./runner";

/** A lock that is always ours: for the non-election tests. */
const freeLock = (): JobLock => {
  let held = false;
  return { tryAcquire: async () => (held = true), release: async () => void (held = false), held: () => held };
};
const quiet = { lockFactory: freeLock, random: () => 0, log: () => undefined };

describe("JobRunner", () => {
  it("runs a job on its tick and logs its summary", async () => {
    const lines: string[] = [];
    const r = new JobRunner({ ...quiet, log: (l) => lines.push(l) });
    let runs = 0;
    r.register({ name: "count", everyMs: 1000, run: async () => ({ n: ++runs }) });
    expect(await r.tick("count")).toBe(1000);
    expect(runs).toBe(1);
    expect(lines.some((l) => l.includes('count: ok') && l.includes('{"n":1}'))).toBe(true);
    expect(r.status()[0]).toMatchObject({ leader: true, lastOk: true, consecutiveFailures: 0 });
  });

  it("backs off exponentially on failure, caps at an hour, and resets on success", async () => {
    const lines: string[] = [];
    const r = new JobRunner({ ...quiet, log: (l) => lines.push(l) });
    let fail = true;
    r.register({ name: "flaky", everyMs: 60_000, run: async () => { if (fail) throw new Error("graph down"); } });
    expect(await r.tick("flaky")).toBe(120_000);
    expect(await r.tick("flaky")).toBe(240_000);
    for (let i = 0; i < 10; i++) await r.tick("flaky");
    expect(await r.tick("flaky")).toBe(60 * 60_000);
    // Logged once for the failure streak, not on every run.
    expect(lines.filter((l) => l.includes("flaky: failed"))).toHaveLength(1);
    fail = false;
    expect(await r.tick("flaky")).toBe(60_000);
    expect(lines.some((l) => l.includes("flaky: recovered after 13"))).toBe(true);
  });

  it("isolates jobs: one throwing never stops another", async () => {
    const r = new JobRunner(quiet);
    let good = 0;
    r.register({ name: "bad", everyMs: 1000, run: async () => { throw new Error("x"); } });
    r.register({ name: "good", everyMs: 1000, run: async () => void good++ });
    await Promise.all([r.tick("bad"), r.tick("good")]);
    expect(good).toBe(1);
    expect(r.status().find((s) => s.name === "bad")).toMatchObject({ lastOk: false, lastError: "x" });
  });

  it("adds jitter, and never overlaps a run with itself", async () => {
    const r = new JobRunner({ ...quiet, random: () => 0.5 });
    let release!: () => void;
    let runs = 0;
    r.register({ name: "slow", everyMs: 1000, jitterMs: 400, run: () => { runs++; return new Promise<void>((res) => (release = res)); } });
    const first = r.tick("slow");
    await new Promise((res) => setTimeout(res, 0));
    expect(await r.tick("slow")).toBe(1200); // skipped: still running
    release();
    expect(await first).toBe(1200);
    expect(runs).toBe(1);
  });

  it("aborts a run that overstays its timeout", async () => {
    const r = new JobRunner(quiet);
    r.register({
      name: "hang", everyMs: 1000, timeoutMs: 20,
      run: ({ signal }) => new Promise<void>((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
    });
    await r.tick("hang");
    expect(r.status()[0]).toMatchObject({ lastOk: false, lastError: "aborted" });
  });

  it("first ticks within 30s of start (plus jitter), then every everyMs", async () => {
    const r = new JobRunner({ ...quiet, random: () => 0.5 });
    let runs = 0;
    r.register({ name: "soon", everyMs: 5 * 60_000, jitterMs: 100, run: async () => void runs++ });
    r.register({ name: "fast", everyMs: 1000, jitterMs: 0, run: async () => undefined });
    r.start();
    const next = Object.fromEntries(r.status().map((s) => [s.name, Date.parse(s.nextRunAt!) - Date.now()]));
    await r.stop();
    expect(next.soon).toBeGreaterThan(29_000);
    expect(next.soon).toBeLessThanOrEqual(30_050);
    expect(next.fast).toBeLessThanOrEqual(1000);
    expect(runs).toBe(0);
  });

  it("refuses a duplicate name", () => {
    const r = new JobRunner(quiet);
    r.register({ name: "a", everyMs: 1, run: async () => undefined });
    expect(() => r.register({ name: "a", everyMs: 1, run: async () => undefined })).toThrow(/already/);
  });
});

describe("what the admin readout reads", () => {
  it("records when a job last succeeded, and its last error's class", async () => {
    let now = 1_700_000_000_000;
    const r = new JobRunner({ ...quiet, now: () => now });
    let fail = false;
    r.register({ name: "j", everyMs: 1000, run: async () => { if (fail) throw Object.assign(new Error("dup on 1e5fd279-9865-490c-b0d2-c1a2a305c971"), { name: "PrismaClientKnownRequestError", code: "P2002" }); } });
    await r.tick("j");
    expect(r.status()[0]).toMatchObject({ lastSucceededAt: new Date(now).toISOString(), lastErrorClass: null, everyMs: 1000, timeoutMs: 1000 });
    fail = true;
    now += 5000;
    await r.tick("j");
    // A failure leaves the last success where it was.
    expect(r.status()[0]).toMatchObject({ lastSucceededAt: new Date(now - 5000).toISOString(), lastErrorClass: "PrismaClientKnownRequestError P2002", consecutiveFailures: 1 });
    expect(r.isStarted()).toBe(false);
  });

  it("keeps the numbers of each run's summary, and their sum, and nothing else", async () => {
    const r = new JobRunner(quiet);
    let n = 0;
    r.register({ name: "c", everyMs: 1000, run: async () => ({ events: ++n, late: 1, note: "text is not a count" }) });
    await r.tick("c");
    await r.tick("c");
    expect(r.status()[0]).toMatchObject({ lastCounts: { events: 2, late: 1 }, totals: { events: 3, late: 2 } });
    expect(r.status()[0].lastCounts).not.toHaveProperty("note");
  });

  it("says so when a run outlives its timeout without returning", async () => {
    const lines: string[] = [];
    const r = new JobRunner({ ...quiet, log: (l) => lines.push(l) });
    let release!: () => void;
    r.register({ name: "hang", everyMs: 1000, timeoutMs: 5, run: () => new Promise<void>((res) => (release = res)) });
    const run = r.tick("hang");
    await new Promise((res) => setTimeout(res, 30));
    expect(lines).toContain("[jobs] hang: timed out after 5ms; waiting for the run to stop");
    expect(r.status()[0].running).toBe(true);
    release();
    await run;
  });

  it("takes what could be data out of an error message", () => {
    expect(redactMessage('getaddrinfo ENOTFOUND db.internal.example:5432 for "secret value" at 10.0.4.7:6432 by ana@x.org, row 123456 id 1e5fd279-9865-490c-b0d2-c1a2a305c971 https://h/x?q=1\nsecond line')).toBe(
      "getaddrinfo ENOTFOUND <host> for <value> at <address> by <email>, row <n> id <id> <url>",
    );
    expect(redactMessage(null)).toBeNull();
    expect(redactMessage("x".repeat(400))).toHaveLength(160);
    expect(errorClass(new TypeError("boom"))).toBe("TypeError");
    expect(errorClass("nope")).toBe("string");
  });
});

describe("jobsEnabled (kill switch)", () => {
  const base = { DATABASE_URL: "postgres://x" } as unknown as NodeJS.ProcessEnv;
  it("is on with a database", () => expect(jobsEnabled(base)).toBe(true));
  it("doesn't ask for NEXT_RUNTIME: the standalone server (production) leaves it unset at runtime", () => {
    // Reading it here kept every job off in production (`node server.js`) while
    // `next dev`, which sets it, ran them. instrumentation.ts gates the runtime.
    expect(jobsEnabled({ DATABASE_URL: "postgres://x" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(jobsDisabledReason({ DATABASE_URL: "postgres://x" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
  it("is off with JOBS_DISABLED", () => {
    expect(jobsEnabled({ ...base, JOBS_DISABLED: "1" })).toBe(false);
    expect(jobsEnabled({ ...base, JOBS_DISABLED: "true" })).toBe(false);
  });
  it("is off during next build and without a database, and says why", () => {
    expect(jobsEnabled({ ...base, NEXT_PHASE: "phase-production-build" })).toBe(false);
    expect(jobsEnabled({ ...base, DATABASE_URL: "" })).toBe(false);
    expect(jobsDisabledReason({ ...base, JOBS_DISABLED: "1" })).toBe("JOBS_DISABLED");
    expect(jobsDisabledReason({ ...base, DATABASE_URL: "" })).toBe("no DATABASE_URL");
  });
});

// Two runners, as two app instances, on the real database.
describe.skipIf(!process.env.DATABASE_URL)("leader election (e2e DB)", () => {
  const runners: JobRunner[] = [];
  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.stop()));
  });

  it("runs a job on exactly one instance, and fails over when the leader stops", async () => {
    const name = `test-election-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ran: string[] = [];
    const mk = (id: string) => {
      const r = new JobRunner({ lockFactory: (n) => pgJobLock(n), random: () => 0, log: () => undefined });
      r.register({ name, everyMs: 1000, run: async () => void ran.push(id) });
      runners.push(r);
      return r;
    };
    const a = mk("a");
    const b = mk("b");
    await Promise.all([a.tick(name), b.tick(name)]);
    await Promise.all([a.tick(name), b.tick(name)]);
    expect(ran).toHaveLength(2);
    expect(new Set(ran).size).toBe(1); // the same instance both times
    const [leader, other] = ran[0] === "a" ? [a, b] : [b, a];
    expect(other.status()[0].leader).toBe(false);
    await leader.stop();
    await other.tick(name);
    expect(ran).toHaveLength(3);
    expect(ran[2]).not.toBe(ran[0]);
    expect(other.status()[0].leader).toBe(true);
  });

  it("takes over when the leader's connection dies without a clean stop", async () => {
    const name = `test-failover-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const la = pgJobLock(name);
    const lb = pgJobLock(name);
    expect(await la.tryAcquire()).toBe(true);
    expect(await lb.tryAcquire()).toBe(false);
    // Kill the lock holder's backend from outside, as a network drop or DB restart would.
    const { Client } = await import("pg");
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const killed = await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND classid = $1
          AND objid = (hashtext($2)::bigint & 4294967295)::oid`,
      [JOBS_LOCK_NAMESPACE, name],
    );
    await c.end();
    expect(killed.rowCount).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(await lb.tryAcquire()).toBe(true);
    expect(await la.tryAcquire()).toBe(false); // a notices it lost the lock
    await la.release();
    await lb.release();
  });
});
