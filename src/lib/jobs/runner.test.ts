// The shared job runner: one leader per job across instances (a real Postgres
// advisory lock), failures isolated per job with capped exponential backoff,
// and a kill switch. Ticks are driven directly, so nothing here waits on timers.
import { describe, it, expect, afterEach } from "vitest";
import { JOBS_LOCK_NAMESPACE, JobRunner, jobsEnabled, pgJobLock, type JobLock } from "./runner";

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

describe("jobsEnabled (kill switch)", () => {
  const base = { NEXT_RUNTIME: "nodejs", DATABASE_URL: "postgres://x" } as unknown as NodeJS.ProcessEnv;
  it("is on in the Node server runtime with a database", () => expect(jobsEnabled(base)).toBe(true));
  it("is off with JOBS_DISABLED", () => {
    expect(jobsEnabled({ ...base, JOBS_DISABLED: "1" })).toBe(false);
    expect(jobsEnabled({ ...base, JOBS_DISABLED: "true" })).toBe(false);
  });
  it("is off in the edge runtime, during next build, and without a database", () => {
    expect(jobsEnabled({ ...base, NEXT_RUNTIME: "edge" })).toBe(false);
    expect(jobsEnabled({ ...base, NEXT_PHASE: "phase-production-build" })).toBe(false);
    expect(jobsEnabled({ ...base, DATABASE_URL: "" })).toBe(false);
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
