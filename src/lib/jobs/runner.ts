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
 * during `next build`, and only the Node runtime starts it (instrumentation.ts).
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
  /** When a run last finished without throwing. */
  lastSucceededAt: string | null;
  lastError: string | null;
  /** The last error's class (`TypeError`, `PrismaClientKnownRequestError P2002`), for the admin readout. */
  lastErrorClass: string | null;
  consecutiveFailures: number;
  nextRunAt: string | null;
  /** The numbers in the last run's summary (events, sent, late…), and their sum since this process started. */
  lastCounts: Record<string, number> | null;
  totals: Record<string, number>;
  everyMs: number;
  timeoutMs: number;
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

/** `TypeError`, or a Prisma error with its code. Never the message. */
export function errorClass(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{2,20}$/.test(code) ? `${e.name} ${code}` : e.name;
}

/**
 * An error message with what could be data taken out: URLs, emails, ids,
 * addresses, host names, quoted values and long numbers become placeholders, and only the first line,
 * cut to 160 characters, is kept. For a readout people without the logs see.
 */
export function redactMessage(text: string | null): string | null {
  if (!text) return null;
  return text
    .split("\n")[0]
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/[^\s@,;:"'<>()]+@[^\s@,;:"'<>()]+\.[a-z]{2,}/gi, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<address>")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, "<host>")
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, "<value>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .slice(0, 160);
}

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
        lastOk: null, lastSucceededAt: null, lastError: null, lastErrorClass: null, consecutiveFailures: 0, nextRunAt: null, lastCounts: null, totals: {},
        everyMs: def.everyMs, timeoutMs: def.timeoutMs ?? def.everyMs,
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

  /** Has start() run in this process (and stop() not since)? */
  isStarted(): boolean {
    return this.started;
  }

  status(): JobStatus[] {
    return [...this.jobs.values()].map((e) => ({ ...e.status, totals: { ...e.status.totals } }));
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
    const timeoutMs = e.def.timeoutMs ?? e.def.everyMs;
    const timeout = setTimeout(() => {
      abort.abort(new Error("timed out"));
      // The abort only asks: a run that ignores it keeps the job "running", and
      // every later tick skips it. Say so, once, where the logs can show it.
      this.log(`[jobs] ${name}: timed out after ${timeoutMs}ms; waiting for the run to stop`);
    }, timeoutMs);
    const t0 = this.now();
    try {
      const summary = await e.def.run({ signal: abort.signal });
      if (e.status.consecutiveFailures > 0) this.log(`[jobs] ${name}: recovered after ${e.status.consecutiveFailures} failed run(s)`);
      e.status.consecutiveFailures = 0;
      e.status.lastOk = true;
      e.status.lastSucceededAt = new Date(this.now()).toISOString();
      e.status.lastError = null;
      e.status.lastErrorClass = null;
      if (summary) this.log(`[jobs] ${name}: ok in ${this.now() - t0}ms ${JSON.stringify(summary)}`);
      // Numbers only: counts are what the admin readout may show.
      const counts = summary ? Object.fromEntries(Object.entries(summary).filter((kv): kv is [string, number] => typeof kv[1] === "number")) : null;
      e.status.lastCounts = counts;
      for (const [k, v] of Object.entries(counts ?? {})) e.status.totals[k] = (e.status.totals[k] ?? 0) + v;
    } catch (err) {
      e.status.consecutiveFailures++;
      e.status.lastOk = false;
      const msg = message(err);
      if (e.status.consecutiveFailures === 1 || msg !== e.status.lastError) this.log(`[jobs] ${name}: failed (${msg})`);
      e.status.lastError = msg;
      e.status.lastErrorClass = errorClass(err);
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

/**
 * Why the runner won't start in this process, or null when it will.
 *
 * NOT the runtime: its one caller (instrumentation.ts) already runs only in
 * the Node runtime, and that check is `process.env.NEXT_RUNTIME === "nodejs"`
 * written out, which the compiler inlines. Read here, through `env`, it is not
 * inlined, and the standalone server (`node server.js`, what production runs)
 * leaves NEXT_RUNTIME unset: this check alone kept every job off in production
 * from the day the runner shipped, while `next dev`, which sets it, ran them.
 */
export function jobsDisabledReason(env: NodeJS.ProcessEnv = process.env): "JOBS_DISABLED" | "next build" | "no DATABASE_URL" | null {
  if (env.JOBS_DISABLED === "1" || env.JOBS_DISABLED === "true") return "JOBS_DISABLED";
  if (env.NEXT_PHASE === "phase-production-build") return "next build";
  if (!env.DATABASE_URL) return "no DATABASE_URL";
  return null;
}

/** Should the runner start in this process? */
export function jobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return jobsDisabledReason(env) === null;
}
