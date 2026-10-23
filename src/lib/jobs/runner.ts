import { Client } from "pg";

/**
 * In-process periodic jobs, one runner per job across every app instance.
 *
 * Each job ticks every `everyMs` (plus up to `jitterMs`, so instances don't
 * line up). On a tick an instance tries a Postgres advisory lock for that job
 * on its own dedicated connection; the instance that gets it is the job's
 * leader and keeps the lock until it stops or its connection drops, when
 * another instance takes over on its next tick. Only the leader runs the job.
 * (A dedicated connection, because Prisma pools connections and a
 * session-level lock has to stay on the one that took it.)
 *
 * A job that throws backs off exponentially, capped, and never affects
 * another job. Logging happens on state changes (leader gained or lost,
 * failing, recovered) and once per run when the job returns a summary.
 *
 * JOBS_DISABLED=1 turns all of it off (CI and e2e set it). Nothing runs
 * outside the Node runtime or during `next build`.
 */

export interface JobContext {
  /** Aborted when the runner stops or the run exceeds its timeout. */
  signal: AbortSignal;
}

export interface JobDefinition {
  /** Unique, stable: it names the lock. */
  name: string;
  everyMs: number;
  /** Extra random delay per tick, 0..jitterMs. Default: a tenth of everyMs. */
  jitterMs?: number;
  /** Abort a run after this long. Default: everyMs. */
  timeoutMs?: number;
  /** A returned object is logged as the run's one-line summary. */
  run: (ctx: JobContext) => Promise<void | Record<string, unknown>>;
}

/** The per-job advisory lock, on a connection held for as long as it is ours. */
export interface JobLock {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
  /** True while we hold it; false once released or the connection died. */
  held(): boolean;
}

export type JobLockFactory = (name: string) => JobLock;

export interface JobStatus {
  name: string;
  leader: boolean;
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextRunAt: string | null;
}

/** Lock namespace (first key of the two-int advisory lock). */
export const JOBS_LOCK_NAMESPACE = 20203;
const MAX_BACKOFF_MS = 60 * 60_000;
const FIRST_TICK_MAX_MS = 30_000;

/** A Postgres advisory lock on its own connection. */
export function pgJobLock(name: string, connectionString = process.env.DATABASE_URL ?? ""): JobLock {
  let client: Client | null = null;
  let mine = false;
  const drop = () => {
    mine = false;
    const c = client;
    client = null;
    c?.end().catch(() => undefined);
  };
  return {
    async tryAcquire() {
      if (mine && client) {
        // Still ours only if the connection is still alive.
        try {
          await client.query("SELECT 1");
          return true;
        } catch {
          drop();
        }
      }
      if (!client) {
        const c = new Client({ connectionString, application_name: `cosmos-jobs:${name}` });
        // A dead connection means the lock is gone too: someone else may now lead.
        c.on("error", drop);
        c.on("end", () => {
          if (client === c) drop();
        });
        await c.connect();
        client = c;
      }
      const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS ok", [
        JOBS_LOCK_NAMESPACE,
        name,
      ]);
      mine = Boolean(r.rows[0]?.ok);
      return mine;
    },
    async release() {
      if (client && mine) await client.query("SELECT pg_advisory_unlock($1::int, hashtext($2))", [JOBS_LOCK_NAMESPACE, name]).catch(() => undefined);
      drop();
    },
    held: () => mine && client !== null,
  };
}

interface Entry {
  def: JobDefinition;
  lock: JobLock;
  status: JobStatus;
  timer: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
}

export interface RunnerOptions {
  lockFactory?: JobLockFactory;
  random?: () => number;
  now?: () => number;
  log?: (line: string) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export class JobRunner {
  private jobs = new Map<string, Entry>();
  private started = false;
  private stopping = false;
  private readonly lockFactory: JobLockFactory;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(opts: RunnerOptions = {}) {
    this.lockFactory = opts.lockFactory ?? ((name) => pgJobLock(name));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  register(def: JobDefinition): void {
    if (!def.name || def.everyMs <= 0) throw new Error(`bad job definition: ${def.name}`);
    if (this.jobs.has(def.name)) throw new Error(`job already registered: ${def.name}`);
    const entry: Entry = {
      def,
      lock: this.lockFactory(def.name),
      timer: null,
      abort: null,
      status: {
        name: def.name, leader: false, running: false, lastStartedAt: null, lastFinishedAt: null,
        lastOk: null, lastError: null, consecutiveFailures: 0, nextRunAt: null,
      },
    };
    this.jobs.set(def.name, entry);
    if (this.started) this.schedule(entry, this.firstDelay(entry));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    for (const e of this.jobs.values()) this.schedule(e, this.firstDelay(e));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    for (const e of this.jobs.values()) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      e.abort?.abort();
    }
    await Promise.all([...this.jobs.values()].map((e) => e.lock.release()));
    for (const e of this.jobs.values()) e.status.leader = false;
  }

  status(): JobStatus[] {
    return [...this.jobs.values()].map((e) => ({ ...e.status }));
  }

  /**
   * One tick of one job: take or keep the lead, run if leader. Returns the
   * delay until its next tick. The scheduler calls this; tests call it directly.
   */
  async tick(name: string): Promise<number> {
    const e = this.jobs.get(name);
    if (!e) throw new Error(`unknown job: ${name}`);
    if (e.status.running || this.stopping) return this.delay(e);
    let leader = false;
    try {
      leader = await e.lock.tryAcquire();
    } catch (err) {
      leader = false;
      if (e.status.lastError !== `lock: ${message(err)}`) this.log(`[jobs] ${name}: lock unavailable (${message(err)})`);
      e.status.lastError = `lock: ${message(err)}`;
    }
    if (leader !== e.status.leader) this.log(`[jobs] ${name}: ${leader ? "leading on this instance" : "no longer leading here"}`);
    e.status.leader = leader;
    if (!leader) return this.delay(e);

    e.status.running = true;
    e.status.lastStartedAt = new Date(this.now()).toISOString();
    const abort = new AbortController();
    e.abort = abort;
    const timeout = setTimeout(() => abort.abort(new Error("timed out")), e.def.timeoutMs ?? e.def.everyMs);
    const t0 = this.now();
    try {
      const summary = await e.def.run({ signal: abort.signal });
      if (e.status.consecutiveFailures > 0) this.log(`[jobs] ${name}: recovered after ${e.status.consecutiveFailures} failed run(s)`);
      e.status.consecutiveFailures = 0;
      e.status.lastOk = true;
      e.status.lastError = null;
      if (summary) this.log(`[jobs] ${name}: ok in ${this.now() - t0}ms ${JSON.stringify(summary)}`);
    } catch (err) {
      e.status.consecutiveFailures++;
      e.status.lastOk = false;
      const msg = message(err);
      if (e.status.consecutiveFailures === 1 || msg !== e.status.lastError) this.log(`[jobs] ${name}: failed (${msg})`);
      e.status.lastError = msg;
    } finally {
      clearTimeout(timeout);
      e.abort = null;
      e.status.running = false;
      e.status.lastFinishedAt = new Date(this.now()).toISOString();
    }
    return this.delay(e);
  }

  /** everyMs plus jitter, doubled per consecutive failure, capped at an hour. */
  private delay(e: Entry): number {
    const base = e.def.everyMs * 2 ** Math.min(e.status.consecutiveFailures, 20);
    const jitter = Math.floor(this.random() * (e.def.jitterMs ?? Math.floor(e.def.everyMs / 10)));
    return Math.min(base, Math.max(MAX_BACKOFF_MS, e.def.everyMs)) + jitter;
  }

  /** The first tick after start: soon (a restart shouldn't skip a period), but spread out. */
  private firstDelay(e: Entry): number {
    const jitter = Math.floor(this.random() * (e.def.jitterMs ?? Math.floor(e.def.everyMs / 10)));
    return Math.min(e.def.everyMs, FIRST_TICK_MAX_MS) + jitter;
  }

  private schedule(e: Entry, ms: number) {
    if (!this.started) return;
    e.status.nextRunAt = new Date(this.now() + ms).toISOString();
    e.timer = setTimeout(() => {
      e.timer = null;
      void this.tick(e.def.name)
        .catch(() => this.delay(e))
        .then((next) => this.schedule(e, next));
    }, ms);
    e.timer.unref?.();
  }
}

/** The app's runner. Jobs register on it from src/lib/jobs/jobs.ts. */
const GLOBAL_KEY = Symbol.for("cosmos.jobs.runner");
type Holder = { [GLOBAL_KEY]?: JobRunner };

export function appJobRunner(): JobRunner {
  const g = globalThis as Holder;
  return (g[GLOBAL_KEY] ??= new JobRunner());
}

export function registerJob(def: JobDefinition): void {
  appJobRunner().register(def);
}

/** Should the runner start in this process? */
export function jobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.JOBS_DISABLED === "1" || env.JOBS_DISABLED === "true") return false;
  if (env.NEXT_RUNTIME !== "nodejs") return false;
  if (env.NEXT_PHASE === "phase-production-build") return false;
  return Boolean(env.DATABASE_URL);
}
