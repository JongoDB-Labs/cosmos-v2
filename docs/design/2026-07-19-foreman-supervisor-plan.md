# Foreman Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-grooming "supervisor" to Foreman that autonomously triages parked (`review`) tickets — closing already-delivered/duplicate drafts, re-queuing builds that failed on since-fixed issues, and escalating product questions — with a full audit trail and per-org UI control.

**Architecture:** A pure decision core (`src/lib/foreman/supervisor.ts`, mirrors `planner.ts`) composes a typed `GroomingVerdict` from judgment inputs; a thin daemon orchestrator (`supervisorPass()` in `scripts/foreman/run.mts`) gathers those inputs (GitHub + model + DB), runs on idle ticks, and executes each verdict **event-first then mutate** (idempotent, reversible). Per-org config + observability live in the Foreman console.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Next.js (App Router) for API+UI, vitest, the Claude Agent egress (`runModelTurn`), the existing `analyzeRequirements` GitHub/model plumbing.

## Global Constraints

- **Ships via manual PR + `--admin` merge + `deploy-apponly.sh <version>`** — the supervisor is foreman self-modifying code (`scripts/foreman/`, `src/lib/foreman/` are sensitive paths); it can NEVER auto-ship. Bump `package.json` + prepend a `CHANGELOG` entry per release (CI Config-assertions enforces `CHANGELOG[0].version === package.json version`).
- **Pure logic lives in `src/lib/foreman/*.ts`** (vitest cannot load `.mts` daemon modules); daemon I/O lives in `scripts/foreman/*.mts`. Same split as `planner.ts` ↔ `run.mts`.
- **Every board mutation is event-sourced**: write a `foreman_event` (`kind: "groomed"`) BEFORE mutating; re-check for that event to stay idempotent.
- **Reuse, don't rebuild**: `db.moveColumn`/`comment`/`claimTicket`, `obs.track`, `analyzeRequirements`, `runModelTurn`, the realtime `pg_notify` emit, and `isStandingDemotion`'s human-respect pattern.
- **Model calls use Foreman's own per-org creds** via `runModelTurn` with the credential passed by value (never a human seat) — exactly as `approval-recommendation.ts` does.
- **Autonomy**: act autonomously above the confidence threshold; below ⇒ `escalate`. Cap mutations per pass. Everything reversible. Respect human actions.

---

# Phase 1 — Pure decision core (`src/lib/foreman/supervisor.ts`)

### Task 1: Verdict types + model-reply parser

**Files:**
- Create: `src/lib/foreman/supervisor.ts`
- Test: `src/lib/foreman/supervisor.test.ts`

**Interfaces:**
- Produces: `GroomingKind`, `GroomingVerdict`, `GroomingJudgment`, `parseGroomingReply(raw: string): GroomingJudgment`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/foreman/supervisor.test.ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseGroomingReply } from "./supervisor";

describe("parseGroomingReply", () => {
  it("extracts a delivered judgment from a JSON reply with stray prose", () => {
    const raw =
      'Here is my analysis:\n{"delivered":true,"deliveredConfidence":0.9,' +
      '"evidence":"main sprint-board.tsx scopes to active sprint","dupOf":null,"dupConfidence":0}';
    const j = parseGroomingReply(raw);
    expect(j.delivered).toBe(true);
    expect(j.deliveredConfidence).toBeCloseTo(0.9);
    expect(j.evidence).toContain("sprint-board");
    expect(j.dupOf).toBeNull();
  });

  it("defaults to a safe non-delivered judgment when JSON is absent/garbage", () => {
    const j = parseGroomingReply("model refused");
    expect(j.delivered).toBe(false);
    expect(j.deliveredConfidence).toBe(0);
    expect(j.dupOf).toBeNull();
    expect(j.evidence).toBe("");
  });

  it("clamps confidence to [0,1] and trims a duplicate key", () => {
    const j = parseGroomingReply('{"delivered":false,"deliveredConfidence":5,"dupOf":"  COSMOS-105  ","dupConfidence":0.8}');
    expect(j.deliveredConfidence).toBe(1);
    expect(j.dupOf).toBe("COSMOS-105");
    expect(j.dupConfidence).toBeCloseTo(0.8);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/supervisor.test.ts'`
Expected: FAIL — `parseGroomingReply` is not exported / file missing.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/lib/foreman/supervisor.ts
/**
 * Pure decision core for Foreman's outcome-grooming "supervisor" (sibling to
 * planner.ts). No I/O — the daemon (scripts/foreman/run.mts) gathers the facts and
 * executes the verdict; this module only decides. Unit-tested in isolation.
 */

/** The one action the supervisor takes on a parked ticket. */
export type GroomingKind = "deliver-close" | "requeue" | "dedup-consolidate" | "escalate" | "leave";

/** The composed decision for one ticket. */
export interface GroomingVerdict {
  kind: GroomingKind;
  confidence: number; // 0..1
  evidence: string; // one concise line, shown in the event + UI
  dupOf?: string | null; // canonical ticket key when kind === "dedup-consolidate"
}

/** The model's raw grooming judgment for one ticket (parsed, pre-composition). */
export interface GroomingJudgment {
  delivered: boolean;
  deliveredConfidence: number;
  dupOf: string | null;
  dupConfidence: number;
  evidence: string;
}

const clamp01 = (n: unknown): number => {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
};

/** Parse the grooming model reply (tolerating stray prose / code fences) into a
 *  typed judgment. Safe defaults: not-delivered, no-dup, zero confidence. */
export function parseGroomingReply(raw: string): GroomingJudgment {
  const text = (raw ?? "").trim();
  let o: Record<string, unknown> = {};
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (parsed && typeof parsed === "object") o = parsed as Record<string, unknown>;
    } catch {
      o = {};
    }
  }
  const dupRaw = typeof o.dupOf === "string" ? o.dupOf.trim() : "";
  let evidence = typeof o.evidence === "string" ? o.evidence.trim().replace(/\s+/g, " ") : "";
  if (evidence.length > 240) evidence = `${evidence.slice(0, 239).trimEnd()}…`;
  return {
    delivered: o.delivered === true,
    deliveredConfidence: clamp01(o.deliveredConfidence),
    dupOf: dupRaw.length > 0 ? dupRaw : null,
    dupConfidence: clamp01(o.dupConfidence),
    evidence,
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/supervisor.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/supervisor.ts src/lib/foreman/supervisor.test.ts
git commit -m "feat(foreman): supervisor core — verdict types + grooming-reply parser"
```

---

### Task 2: Re-queue eligibility (known-transient signatures)

**Files:**
- Modify: `src/lib/foreman/supervisor.ts`
- Test: `src/lib/foreman/supervisor.test.ts`

**Interfaces:**
- Produces: `KNOWN_TRANSIENT_SIGNATURES: readonly string[]`, `isRequeueEligible(f: RequeueFacts): boolean`, `RequeueFacts`.

- [ ] **Step 1: Write the failing test**

```ts
import { isRequeueEligible, KNOWN_TRANSIENT_SIGNATURES } from "./supervisor";

describe("isRequeueEligible", () => {
  const base = {
    parkReason: "checks failed",
    checkLog: "",
    parkedAtMs: 1000,
    lastInfraFixAtMs: 2000, // a fix shipped AFTER the park
    currentMainSha: "abc",
    lastRequeuedSha: null as string | null,
    isScopeOrSensitiveGate: false,
  };

  it("re-queues a failure park whose log matches a known-transient signature", () => {
    expect(isRequeueEligible({ ...base, checkLog: "column users.must_change_password does not exist" })).toBe(true);
  });

  it("re-queues a failure park that predates a since-shipped infra fix", () => {
    expect(isRequeueEligible({ ...base, checkLog: "some unrelated failure" })).toBe(true);
  });

  it("does NOT re-queue a scope/sensitive gate (not a failure)", () => {
    expect(isRequeueEligible({ ...base, isScopeOrSensitiveGate: true, parkReason: "9 files changed (> 8)" })).toBe(false);
  });

  it("does NOT re-queue twice at the same main SHA (loop guard)", () => {
    expect(isRequeueEligible({ ...base, lastRequeuedSha: "abc" })).toBe(false);
  });

  it("does NOT re-queue when no signature matches and the park is newer than the last fix", () => {
    expect(isRequeueEligible({ ...base, checkLog: "genuine test failure", lastInfraFixAtMs: 500 })).toBe(false);
  });

  it("exposes the stale-DB and PR-exists signatures", () => {
    expect(KNOWN_TRANSIENT_SIGNATURES.some((s) => "column users.must_change_password does not exist".includes(s))).toBe(true);
    expect(KNOWN_TRANSIENT_SIGNATURES.some((s) => 'a pull request for branch "x" already exists'.includes(s))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/supervisor.test.ts'`
Expected: FAIL — `isRequeueEligible` not exported.

- [ ] **Step 3: Write the minimal implementation** (append to `supervisor.ts`)

```ts
/** Substrings that, when found in a parked build's check log / error, mean the
 *  park was caused by a since-FIXED transient (infra), not by the change itself —
 *  so a fresh rebuild against current main should now pass. Keep this list in sync
 *  as infra bugs are fixed and retired. */
export const KNOWN_TRANSIENT_SIGNATURES: readonly string[] = [
  "must_change_password does not exist", // #367 stale e2e template DB
  "already exists", // #342 C124 "a pull request for branch … already exists"
  "No conversation found with session ID", // #368 shared-HOME resume bug
  "reviewer agent failed twice", // reviewer infra flake
  "did not complete in 1 second", // repair/resume infra failure
];

export interface RequeueFacts {
  parkReason: string;
  checkLog: string;
  parkedAtMs: number;
  /** ms timestamp of the most recent infra fix relevant to builds, or null. */
  lastInfraFixAtMs: number | null;
  currentMainSha: string;
  /** The main SHA at which THIS ticket was last re-queued, or null if never. */
  lastRequeuedSha: string | null;
  /** True when the park was a scope/sensitive risk-gate, not a failure. */
  isScopeOrSensitiveGate: boolean;
}

/** A parked ticket is re-queue-eligible when it parked on a FAILURE (not a
 *  scope/sensitive gate), we have not already re-queued it at the current main SHA
 *  (loop guard), and EITHER its log matches a known-transient signature OR the park
 *  predates a since-shipped infra fix (so main has advanced past the cause). */
export function isRequeueEligible(f: RequeueFacts): boolean {
  if (f.isScopeOrSensitiveGate) return false;
  if (f.lastRequeuedSha !== null && f.lastRequeuedSha === f.currentMainSha) return false;
  const hay = `${f.parkReason}\n${f.checkLog}`;
  if (KNOWN_TRANSIENT_SIGNATURES.some((sig) => hay.includes(sig))) return true;
  if (f.lastInfraFixAtMs !== null && f.lastInfraFixAtMs > f.parkedAtMs) return true;
  return false;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/supervisor.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/supervisor.ts src/lib/foreman/supervisor.test.ts
git commit -m "feat(foreman): supervisor core — re-queue eligibility + transient signatures"
```

---

### Task 3: Human-action-respect predicate

**Files:**
- Modify: `src/lib/foreman/supervisor.ts`
- Test: `src/lib/foreman/supervisor.test.ts`

**Interfaces:**
- Produces: `isHumanSuppressed(f: { lastGroomedAtMs: number | null; updatedAtMs: number; lastCommentAtMs: number | null; lastHumanMoveAtMs: number | null }): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import { isHumanSuppressed } from "./supervisor";

describe("isHumanSuppressed", () => {
  const base = { lastGroomedAtMs: 1000, updatedAtMs: 900, lastCommentAtMs: null, lastHumanMoveAtMs: null };
  it("not suppressed when nothing changed since the last groom", () => {
    expect(isHumanSuppressed(base)).toBe(false);
  });
  it("suppressed when a human edited after the last groom", () => {
    expect(isHumanSuppressed({ ...base, updatedAtMs: 2000 })).toBe(true);
  });
  it("suppressed when a human commented after the last groom", () => {
    expect(isHumanSuppressed({ ...base, lastCommentAtMs: 1500 })).toBe(true);
  });
  it("suppressed when a human moved the card after the last groom", () => {
    expect(isHumanSuppressed({ ...base, lastHumanMoveAtMs: 1500 })).toBe(true);
  });
  it("never suppressed when the ticket has never been groomed", () => {
    expect(isHumanSuppressed({ ...base, lastGroomedAtMs: null, updatedAtMs: 9e9 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/supervisor.test.ts'`
Expected: FAIL — `isHumanSuppressed` not exported.

- [ ] **Step 3: Write the minimal implementation** (append to `supervisor.ts`)

```ts
/** A ticket must NOT be re-groomed while a human has acted on it since Foreman's
 *  last grooming action — mirrors planner.isStandingDemotion. Only meaningful once
 *  the ticket has been groomed at least once (lastGroomedAtMs set); a never-groomed
 *  ticket is always eligible. Any edit/comment/human-move after the last groom
 *  hands control back to the human. */
export function isHumanSuppressed(f: {
  lastGroomedAtMs: number | null;
  updatedAtMs: number;
  lastCommentAtMs: number | null;
  lastHumanMoveAtMs: number | null;
}): boolean {
  if (f.lastGroomedAtMs === null) return false;
  const g = f.lastGroomedAtMs;
  if (f.updatedAtMs > g) return true;
  if (f.lastCommentAtMs !== null && f.lastCommentAtMs > g) return true;
  if (f.lastHumanMoveAtMs !== null && f.lastHumanMoveAtMs > g) return true;
  return false;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/supervisor.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/supervisor.ts src/lib/foreman/supervisor.test.ts
git commit -m "feat(foreman): supervisor core — human-action-respect predicate"
```

---

### Task 4: `decideVerdict` — compose the verdict + confidence gate + per-behavior toggles

**Files:**
- Modify: `src/lib/foreman/supervisor.ts`
- Test: `src/lib/foreman/supervisor.test.ts`

**Interfaces:**
- Consumes: `GroomingJudgment` (Task 1), `RequeueFacts`/`isRequeueEligible` (Task 2).
- Produces: `SupervisorConfig`, `SupervisorFacts`, `decideVerdict(facts: SupervisorFacts, cfg: SupervisorConfig): GroomingVerdict`, `DEFAULT_CONFIG`.

- [ ] **Step 1: Write the failing test**

```ts
import { decideVerdict, DEFAULT_CONFIG, type SupervisorFacts } from "./supervisor";

const facts = (over: Partial<SupervisorFacts> = {}): SupervisorFacts => ({
  hasPr: true,
  judgment: { delivered: false, deliveredConfidence: 0, dupOf: null, dupConfidence: 0, evidence: "" },
  requeue: {
    parkReason: "checks failed", checkLog: "must_change_password does not exist",
    parkedAtMs: 1000, lastInfraFixAtMs: 2000, currentMainSha: "abc",
    lastRequeuedSha: null, isScopeOrSensitiveGate: false,
  },
  touchesSensitiveForemanPath: false,
  agentAskedForInput: false,
  ...over,
});

describe("decideVerdict", () => {
  it("deliver-close when delivered above threshold", () => {
    const v = decideVerdict(facts({ judgment: { delivered: true, deliveredConfidence: 0.95, dupOf: null, dupConfidence: 0, evidence: "on main" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("deliver-close");
    expect(v.evidence).toBe("on main");
  });
  it("escalates instead of deliver-close when delivered but below threshold", () => {
    const v = decideVerdict(facts({ judgment: { delivered: true, deliveredConfidence: 0.5, dupOf: null, dupConfidence: 0, evidence: "maybe" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("escalate");
  });
  it("dedup-consolidate when a confident duplicate is found (and not delivered)", () => {
    const v = decideVerdict(facts({ judgment: { delivered: false, deliveredConfidence: 0, dupOf: "COSMOS-105", dupConfidence: 0.9, evidence: "same as 105" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("dedup-consolidate");
    expect(v.dupOf).toBe("COSMOS-105");
  });
  it("requeue when not delivered/dup but re-queue-eligible", () => {
    const v = decideVerdict(facts(), DEFAULT_CONFIG);
    expect(v.kind).toBe("requeue");
  });
  it("escalates when the build agent explicitly asked for input", () => {
    const v = decideVerdict(facts({ agentAskedForInput: true, requeue: { ...facts().requeue, isScopeOrSensitiveGate: true } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("escalate");
  });
  it("leaves a scope-gated ticket with nothing actionable", () => {
    const v = decideVerdict(facts({ requeue: { ...facts().requeue, isScopeOrSensitiveGate: true, checkLog: "" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("leave");
  });
  it("escalates (not deliver-close) a sensitive foreman-path ticket even when confident", () => {
    const v = decideVerdict(facts({ touchesSensitiveForemanPath: true, judgment: { delivered: true, deliveredConfidence: 0.99, dupOf: null, dupConfidence: 0, evidence: "on main" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("escalate");
  });
  it("respects a disabled behavior (deliver-close off ⇒ escalate)", () => {
    const cfg = { ...DEFAULT_CONFIG, deliverClose: false };
    const v = decideVerdict(facts({ judgment: { delivered: true, deliveredConfidence: 0.99, dupOf: null, dupConfidence: 0, evidence: "on main" } }), cfg);
    expect(v.kind).toBe("escalate");
  });
  it("no-PR delivered ⇒ leave (nothing to close) — delivered-close needs a draft", () => {
    const v = decideVerdict(facts({ hasPr: false, requeue: { ...facts().requeue, isScopeOrSensitiveGate: true, checkLog: "" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("leave");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/supervisor.test.ts'`
Expected: FAIL — `decideVerdict` not exported.

- [ ] **Step 3: Write the minimal implementation** (append to `supervisor.ts`)

```ts
export interface SupervisorConfig {
  deliverClose: boolean;
  requeue: boolean;
  dedup: boolean;
  escalate: boolean;
  /** Confidence at/above which deliver-close and dedup act autonomously. */
  confidenceThreshold: number;
  /** Max autonomous mutations executed per pass. */
  perPassCap: number;
}

export const DEFAULT_CONFIG: SupervisorConfig = {
  deliverClose: true,
  requeue: true,
  dedup: true,
  escalate: true,
  confidenceThreshold: 0.8,
  perPassCap: 5,
};

export interface SupervisorFacts {
  hasPr: boolean;
  judgment: GroomingJudgment;
  requeue: RequeueFacts;
  touchesSensitiveForemanPath: boolean;
  agentAskedForInput: boolean;
}

/** Compose the single grooming verdict for one parked ticket. Precedence:
 *  agent-asked-for-input ⇒ escalate; then deliver-close (confident, has a PR, not a
 *  sensitive foreman-path change); then dedup; then requeue; else leave. A confident
 *  deliver-close/dedup on a DISABLED behavior, below threshold, or on a sensitive
 *  foreman path downgrades to escalate (never a silent wrong close). */
export function decideVerdict(f: SupervisorFacts, cfg: SupervisorConfig): GroomingVerdict {
  const j = f.judgment;
  const esc = (evidence: string): GroomingVerdict => ({ kind: "escalate", confidence: 1, evidence });

  if (f.agentAskedForInput) return cfg.escalate ? esc(j.evidence || "build agent asked for input") : { kind: "leave", confidence: 1, evidence: "" };

  // deliver-close
  if (f.hasPr && j.delivered) {
    const confident = j.deliveredConfidence >= cfg.confidenceThreshold;
    if (confident && cfg.deliverClose && !f.touchesSensitiveForemanPath) {
      return { kind: "deliver-close", confidence: j.deliveredConfidence, evidence: j.evidence };
    }
    if (cfg.escalate) return esc(j.evidence || "possibly already delivered — confirm");
  }

  // dedup
  if (j.dupOf && j.dupConfidence >= cfg.confidenceThreshold) {
    if (cfg.dedup && f.hasPr) return { kind: "dedup-consolidate", confidence: j.dupConfidence, evidence: j.evidence, dupOf: j.dupOf };
    if (cfg.escalate) return esc(j.evidence || `possible duplicate of ${j.dupOf}`);
  }

  // requeue
  if (isRequeueEligible(f.requeue)) {
    if (cfg.requeue) return { kind: "requeue", confidence: 1, evidence: `re-queue: ${f.requeue.parkReason}`.slice(0, 240) };
    if (cfg.escalate) return esc(`would re-queue: ${f.requeue.parkReason}`);
  }

  return { kind: "leave", confidence: 1, evidence: "" };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/supervisor.test.ts'`
Expected: PASS (all Task-4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/supervisor.ts src/lib/foreman/supervisor.test.ts
git commit -m "feat(foreman): supervisor core — decideVerdict composition + gates"
```

---

### Task 5: Per-pass cap selection

**Files:**
- Modify: `src/lib/foreman/supervisor.ts`
- Test: `src/lib/foreman/supervisor.test.ts`

**Interfaces:**
- Produces: `selectWithinCap<T>(items: { verdict: GroomingVerdict; item: T }[], cap: number): { act: {verdict: GroomingVerdict; item: T}[]; deferred: {verdict: GroomingVerdict; item: T}[] }`.

- [ ] **Step 1: Write the failing test**

```ts
import { selectWithinCap, type GroomingVerdict } from "./supervisor";
const v = (kind: GroomingVerdict["kind"]): GroomingVerdict => ({ kind, confidence: 1, evidence: "" });

describe("selectWithinCap", () => {
  it("escalate + leave never count against the cap; only mutating verdicts do", () => {
    const items = [
      { verdict: v("escalate"), item: 1 }, { verdict: v("leave"), item: 2 },
      { verdict: v("deliver-close"), item: 3 }, { verdict: v("requeue"), item: 4 },
      { verdict: v("dedup-consolidate"), item: 5 },
    ];
    const { act, deferred } = selectWithinCap(items, 2);
    // both non-mutating pass through in `act`; only 2 of the 3 mutating ones act
    expect(act.filter((a) => a.verdict.kind === "escalate" || a.verdict.kind === "leave")).toHaveLength(2);
    expect(act.filter((a) => ["deliver-close", "requeue", "dedup-consolidate"].includes(a.verdict.kind))).toHaveLength(2);
    expect(deferred).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/supervisor.test.ts'`
Expected: FAIL — `selectWithinCap` not exported.

- [ ] **Step 3: Write the minimal implementation** (append to `supervisor.ts`)

```ts
const MUTATING: ReadonlySet<GroomingKind> = new Set(["deliver-close", "requeue", "dedup-consolidate"]);

/** Split verdicts into those to act on now vs deferred to the next pass. Only
 *  MUTATING verdicts consume the cap; escalate/leave always pass through (they post
 *  a comment or do nothing, so they can't mass-mutate the board). Deterministic:
 *  preserves input order. */
export function selectWithinCap<T>(
  items: { verdict: GroomingVerdict; item: T }[],
  cap: number,
): { act: { verdict: GroomingVerdict; item: T }[]; deferred: { verdict: GroomingVerdict; item: T }[] } {
  const act: { verdict: GroomingVerdict; item: T }[] = [];
  const deferred: { verdict: GroomingVerdict; item: T }[] = [];
  let used = 0;
  for (const it of items) {
    if (!MUTATING.has(it.verdict.kind)) { act.push(it); continue; }
    if (used < cap) { act.push(it); used++; } else deferred.push(it);
  }
  return { act, deferred };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/supervisor.test.ts'`
Expected: PASS. **Phase 1 core complete.**

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/supervisor.ts src/lib/foreman/supervisor.test.ts
git commit -m "feat(foreman): supervisor core — per-pass mutation cap"
```

---

# Phase 2 — Daemon glue, event-sourcing, dry mode

### Task 6: `groomed` event kind + a `groomed`-event reader

**Files:**
- Modify: `src/lib/foreman/observe.ts` (the `ForemanEventKind` union) — confirm exact file via `git grep -n "ForemanEventKind" origin/main`
- Modify: `scripts/foreman/db.mts` — add `lastGroomedEvent(itemId)` + `lastRequeuedSha(itemId)` readers.
- Test: `src/lib/foreman/__tests__/supervisor-db.test.ts` (integration, uses the e2e DB like `observe-db.test.ts`).

**Interfaces:**
- Produces: `"groomed"` added to `ForemanEventKind`; `db.lastGroomedEvent(itemId): Promise<{ ts: Date; data: Record<string, unknown> } | null>`; `db.lastRequeuedSha(itemId): Promise<string | null>`.

- [ ] **Step 1: Add `"groomed"` to the `ForemanEventKind` union.**

Find it: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && git grep -n "type ForemanEventKind" origin/main'`. Add `| "groomed"` to the union (it feeds `obs.track` and the console feed's known kinds).

- [ ] **Step 2: Write the failing integration test** (mirror `src/lib/foreman/__tests__/observe-db.test.ts` setup)

```ts
// creates a work item + a "groomed" foreman_event with data { action, sha, evidence },
// then asserts lastGroomedEvent returns it and lastRequeuedSha returns the sha for a
// requeue-action event.
```
(Write the concrete arrange/act/assert mirroring `observe-db.test.ts`'s prisma setup.)

- [ ] **Step 3: Implement the readers in `scripts/foreman/db.mts`**

```ts
/** Most recent supervisor grooming event for an item (or null). */
export async function lastGroomedEvent(itemId: string): Promise<{ ts: Date; data: Record<string, unknown> } | null> {
  const ev = await prisma.foremanEvent.findFirst({
    where: { workItemId: itemId, kind: "groomed" },
    orderBy: [{ ts: "desc" }, { id: "desc" }],
    select: { ts: true, data: true },
  });
  return ev ? { ts: ev.ts, data: (ev.data ?? {}) as Record<string, unknown> } : null;
}

/** The main SHA at which this item was last re-queued by the supervisor, or null. */
export async function lastRequeuedSha(itemId: string): Promise<string | null> {
  const ev = await prisma.foremanEvent.findFirst({
    where: { workItemId: itemId, kind: "groomed", data: { path: ["action"], equals: "requeue" } },
    orderBy: [{ ts: "desc" }, { id: "desc" }],
    select: { data: true },
  });
  const sha = (ev?.data as { sha?: unknown } | undefined)?.sha;
  return typeof sha === "string" ? sha : null;
}
```

- [ ] **Step 4: Run the integration test**

Run: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx vitest run src/lib/foreman/__tests__/supervisor-db.test.ts'`
Expected: PASS (requires the e2e DB; if unavailable locally, CI runs it).

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/observe.ts scripts/foreman/db.mts src/lib/foreman/__tests__/supervisor-db.test.ts
git commit -m "feat(foreman): groomed event kind + grooming-event readers"
```

---

### Task 7: Fact-gathering + verdict execution (`scripts/foreman/supervisor-run.mts`)

**Files:**
- Create: `scripts/foreman/supervisor-run.mts` — the I/O side: `gatherFacts(item)`, `runGroomingJudgment(...)`, `executeVerdict(item, verdict, dry)`.
- Reuse: `analyzeRequirements` (delivered), `runModelTurn` (delivered/dedup judgment), `db.moveColumn`/`comment`, `obs.track`, `configureGithubAuth` token for GitHub reads, `pickParkEvent`/`PARKED_EVENT_KINDS`.

**Interfaces:**
- Consumes: `parseGroomingReply`, `decideVerdict`, `SupervisorFacts`, `SupervisorConfig` (Phase 1); `db.lastGroomedEvent`/`lastRequeuedSha` (Task 6).
- Produces: `groomOne(item, cfg, dry): Promise<GroomingVerdict>` and `gatherReviewItems(orgIds): Promise<ReviewItem[]>`.

- [ ] **Step 1: Write the grooming judgment prompt + model call** (pure-ish; unit-test the prompt builder)

Add `buildGroomingPrompt(ticket, prDiffOrMainEvidence, otherTicketsIndex)` to `src/lib/foreman/supervisor.ts` and a test asserting it contains the ticket title, the "already on main independent of this PR?" question, and the JSON-only instruction. Then in `supervisor-run.mts`, call `runModelTurn({ ctx, system: GROOMING_SYSTEM, messages:[{role:"user",content: buildGroomingPrompt(...)}], model:"sonnet", maxTokens: 500, credential })` with Foreman's creds (mirror `recommendForApproval`), and `parseGroomingReply(reply.text)`.

- [ ] **Step 2: Implement `executeVerdict`** — event-first, then mutate, idempotent, dry-aware

```ts
// scripts/foreman/supervisor-run.mts (sketch — fill concrete imports)
export async function executeVerdict(item: ReviewItem, v: GroomingVerdict, dry: boolean): Promise<void> {
  if (v.kind === "leave") return;
  if (dry) { await obs.track({ workItemId: item.id, orgId: item.orgId, ticketKey: item.ref, kind: "groomed",
    message: `[dry] ${v.kind}: ${v.evidence}`, data: { action: v.kind, dry: true, evidence: v.evidence, dupOf: v.dupOf ?? null } }); return; }

  // 1. EVENT FIRST (records intent + prior state → idempotent + reversible)
  await obs.trackStrict({ workItemId: item.id, orgId: item.orgId, ticketKey: item.ref, kind: "groomed",
    message: `${v.kind}: ${v.evidence}`, data: { action: v.kind, evidence: v.evidence, dupOf: v.dupOf ?? null,
      sha: item.currentMainSha, priorColumn: item.columnKey, prUrl: item.prUrl ?? null } });

  // 2. MUTATE
  switch (v.kind) {
    case "deliver-close":
      if (item.prUrl) await closePr(item.prUrl, `Delivered on main (supervisor): ${v.evidence}`);
      await db.moveColumn(item.id, "done");
      break;
    case "dedup-consolidate":
      if (item.prUrl) await closePr(item.prUrl, `Duplicate of ${v.dupOf} (supervisor): ${v.evidence}`);
      await db.comment(item.id, `Consolidated into ${v.dupOf} by the supervisor: ${v.evidence}`);
      await db.moveColumn(item.id, "done");
      break;
    case "requeue":
      await db.moveColumn(item.id, "backlog"); // planner re-picks a FRESH build vs current main
      break;
    case "escalate":
      await db.comment(item.id, `Supervisor needs a human: ${v.evidence}`);
      break;
  }
}
```
`closePr(prUrl, comment)` shells `gh pr close <n> --comment ... ` via the configured GH token (same auth `configureGithubAuth` sets up; parse the number with `parsePrUrl`).

- [ ] **Step 3: Implement `gatherReviewItems` + `gatherFacts`** — read `review`-column items for the delivery orgs, their latest park event (`pickParkEvent`) for reason + PR URL + check log, `db.lastGroomedEvent`/`lastRequeuedSha`, `updatedAt`/last comment/last human move, and `touchesSensitiveForemanPath` (does the PR touch `scripts/foreman/`|`src/lib/foreman/`). Assemble `SupervisorFacts`.

- [ ] **Step 4: Wire `groomOne`** — `gatherFacts` → if `isHumanSuppressed` skip (`leave`) → `runGroomingJudgment` → `decideVerdict` → return verdict (execution happens in the pass, after cap).

- [ ] **Step 5: Test + commit** — unit-test `buildGroomingPrompt`; the execution path is covered by the Task 8 dry-run smoke + manual dry validation.

```bash
git add scripts/foreman/supervisor-run.mts src/lib/foreman/supervisor.ts src/lib/foreman/supervisor.test.ts
git commit -m "feat(foreman): supervisor I/O — fact-gathering, judgment, idempotent execute"
```

---

### Task 8: Hook `supervisorPass()` into the daemon loop

**Files:**
- Modify: `scripts/foreman/run.mts` — add `supervisorPass()` and call it at the idle point (after `inflight.size === 0`, before the cycle sleep), gated on settings + a min-interval + `DRY`/mode.

**Interfaces:**
- Consumes: `groomOne`, `gatherReviewItems`, `executeVerdict` (Task 7); `selectWithinCap` (Task 5); `getForemanSupervisorSettings` (Task 10).

- [ ] **Step 1** Add a module-scope `let lastSupervisorPassMs = 0` and `SUPERVISOR_MIN_INTERVAL_MS = 5 * 60_000`.

- [ ] **Step 2** Implement `supervisorPass()`:

```ts
async function supervisorPass(): Promise<void> {
  if (Date.now() - lastSupervisorPassMs < SUPERVISOR_MIN_INTERVAL_MS) return;
  lastSupervisorPassMs = Date.now();
  const orgIds = await db.deliveryOrgIds();
  for (const orgId of orgIds) {
    const cfg = await getForemanSupervisorSettings(orgId);
    if (cfg.mode === "off") continue;
    const dry = cfg.mode === "dry";
    const items = await gatherReviewItems([orgId]);
    const verdicts = [];
    for (const item of items) verdicts.push({ item, verdict: await groomOne(item, cfg, dry) });
    const { act, deferred } = selectWithinCap(verdicts.map((x) => ({ verdict: x.verdict, item: x.item })), cfg.perPassCap);
    for (const a of act) await executeVerdict(a.item, a.verdict, dry);
    if (deferred.length) log(`supervisor: ${deferred.length} action(s) deferred by per-pass cap (org ${orgId})`);
  }
}
```

- [ ] **Step 3** Call it at the drained-queue idle point in `main()` (right after the block that detects `inflight.size === 0` / before `idleSleep`): `await supervisorPass().catch((e) => log(`supervisor pass error: ${String(e)}`));`

- [ ] **Step 4** Manual dry validation (no unit test — daemon integration): deploy with the org's supervisor mode = `dry`, watch `journalctl -u foreman.service` for `[dry] <kind>` groomed events, confirm verdicts look right against the real `review` column.

- [ ] **Step 5: Commit**

```bash
git add scripts/foreman/run.mts
git commit -m "feat(foreman): run supervisorPass on idle ticks (min-interval, per-org, dry-aware)"
```

---

# Phase 3 — Per-org settings model + config API + UI card

### Task 9: `ForemanSupervisorSettings` Prisma model + migration

**Files:**
- Modify: `prisma/schema.prisma` (add the model near `ForemanAiSettings` ~L2923; add the back-relation on `Organization`)
- Create: a migration via `prisma migrate dev --name foreman_supervisor_settings` (generates `prisma/migrations/<ts>_foreman_supervisor_settings/migration.sql`)

**Interfaces:**
- Produces: table `foreman_supervisor_settings` with columns `org_id (unique)`, `mode`, `deliver_close`, `requeue`, `dedup`, `escalate`, `confidence_threshold`, `per_pass_cap`, timestamps.

- [ ] **Step 1** Add the model (mirrors `ForemanAiSettings`, no secrets):

```prisma
model ForemanSupervisorSettings {
  id                  String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId               String   @unique @map("org_id") @db.Uuid
  mode                String   @default("dry") // off | dry | live
  deliverClose        Boolean  @default(true)  @map("deliver_close")
  requeue             Boolean  @default(true)
  dedup               Boolean  @default(true)
  escalate            Boolean  @default(true)
  confidenceThreshold Float    @default(0.8)   @map("confidence_threshold")
  perPassCap          Int      @default(5)     @map("per_pass_cap")
  updatedById         String?  @map("updated_by_id") @db.Uuid
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@map("foreman_supervisor_settings")
}
```
Add `foremanSupervisorSettings ForemanSupervisorSettings?` to `model Organization`.

- [ ] **Step 2** Generate the migration: `ec2_sh 'cd /home/ubuntu/cosmos-v2 && npx prisma migrate dev --name foreman_supervisor_settings'` (defaults make it non-destructive). **Default `mode = "dry"`** so the feature ships inert.

- [ ] **Step 3** `npx prisma generate` + `npx tsc --noEmit` clean.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(foreman): ForemanSupervisorSettings per-org model + migration (default dry)"
```

---

### Task 10: Settings reader with defaults

**Files:**
- Create: `src/lib/foreman/supervisor-settings.ts`
- Test: `src/lib/foreman/__tests__/supervisor-settings.test.ts` (integration, e2e DB)

**Interfaces:**
- Produces: `SupervisorMode = "off"|"dry"|"live"`; `getForemanSupervisorSettings(orgId): Promise<SupervisorConfig & { mode: SupervisorMode }>` — returns row or `DEFAULT_CONFIG` + `mode:"dry"` when absent.

- [ ] **Steps** Write a test (no row ⇒ defaults with `mode:"dry"`; a row ⇒ its values). Implement reading `prisma.foremanSupervisorSettings.findUnique({ where:{orgId} })`, mapping to `SupervisorConfig` (Phase 1) + `mode`. Import `DEFAULT_CONFIG` from `supervisor.ts` for the fallback so defaults never drift. Commit `feat(foreman): supervisor settings reader with dry default`.

---

### Task 11: Config API route (GET/PUT, ORG_MANAGE_SETTINGS)

**Files:**
- Create: `src/app/api/v1/orgs/[orgId]/foreman/supervisor/route.ts`
- Test: `src/app/api/v1/orgs/[orgId]/foreman/supervisor/route.test.ts`

**Interfaces:** GET → current settings (or defaults); PUT → validate+upsert. Mirror the auth/handler shape of `src/app/api/v1/orgs/[orgId]/foreman/github/route.ts` (that file's `requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS)` + `handleApiError`).

- [ ] **Steps** Write a zod schema (`mode: z.enum(["off","dry","live"])`, the four booleans, `confidenceThreshold: z.number().min(0).max(1)`, `perPassCap: z.number().int().min(1).max(50)`). GET returns `getForemanSupervisorSettings`. PUT upserts `prisma.foremanSupervisorSettings` with `updatedById = ctx.userId`. Gate both with `ORG_MANAGE_SETTINGS` (mirror the github route exactly). Test both verbs + the 403 for a non-manager. Commit `feat(foreman): supervisor config API (GET/PUT, ORG_MANAGE_SETTINGS)`.

---

### Task 12: Supervisor settings card (console UI)

**Files:**
- Create: `src/components/foreman/foreman-supervisor-panel.tsx`
- Mount it in the Foreman console settings area next to the GitHub panel (find the mount site: `git grep -n "ForemanGithubPanel" origin/main`).
- Test: `src/components/foreman/foreman-supervisor-panel.test.tsx`

**Interfaces:** Mirror `src/components/foreman/foreman-github-panel.tsx` structure (fetch settings, form state, PUT on save, `notifyError`). Renders a **Mode** segmented control (off/dry/live), four behavior checkboxes, and an "Advanced" `<details>` with threshold + cap.

- [ ] **Steps** Write a test that renders the panel with a mocked GET returning `mode:"dry"`, asserts the mode control shows "dry" and toggling a behavior + Save issues a PUT with the new body. Implement mirroring the github panel. Include short inline directions ("Dry mode proposes actions without changing anything; Live acts autonomously"). Commit `feat(foreman): supervisor settings card in the console`.

---

# Phase 4 — Observability

### Task 13: Grooming feed (API + console section)

**Files:**
- Create: `src/app/api/v1/orgs/[orgId]/foreman/grooming/route.ts` (GET recent `groomed` events, `ORG_UPDATE`-gated like the AI-analysis route).
- Modify: the Foreman console activity area to render a "Supervisor" section/filter from those events (find via `git grep -n "activity" origin/main -- src/components/foreman`).
- Test: route test.

- [ ] **Steps** GET returns the org's recent `foreman_events` where `kind:"groomed"` (ticket ref, message, `data.action`, `data.evidence`, ts). Render them live (subscribe to the existing realtime channel; `groomed` events already flow through `pg_notify` via `obs.track`). Test the route. Commit `feat(foreman): grooming activity feed (API + console)`.

### Task 14: Dry-run preview + Apply

**Files:**
- Modify: the grooming route to also serve **dry** verdicts (events where `data.dry === true`).
- Modify: the console section — when org mode is `dry`, render the would-take verdicts with a per-row **Apply** button that POSTs to a small `…/foreman/grooming/apply` route which runs `executeVerdict` for that single item in live mode (server-side, ORG_MANAGE_SETTINGS).
- Test: apply-route test.

- [ ] **Steps** Implement the apply route (re-gather facts for the one item, recompute the verdict server-side — never trust the client's verdict — and `executeVerdict(..., dry=false)`). Test it. Commit `feat(foreman): dry-run grooming preview with per-row Apply`.

### Task 15: Per-ticket badge + one-click undo

**Files:**
- Modify: the parked-ticket card/detail in the console to show the latest `groomed` verdict for that item (reuse the feed data keyed by workItemId).
- Create: `…/foreman/grooming/undo` route — reopens the PR / moves the card back to `data.priorColumn` from the grooming event, and writes an `updatedAt`-bumping comment so `isHumanSuppressed` blocks re-grooming.
- Test: undo-route test.

- [ ] **Steps** Badge renders "supervisor: <action> · <relative time>" + evidence tooltip. Undo route (ORG_MANAGE_SETTINGS): read the item's last `groomed` event, reverse it (`gh pr reopen`, `moveColumn(priorColumn)`), comment "Undone by <user>". Test. Commit `feat(foreman): per-ticket supervisor badge + one-click undo`.

---

# Ship (whole feature)

- [ ] Bump `package.json` (next patch/minor) + prepend a `CHANGELOG` entry (`CHANGELOG[0].version === package.json version`).
- [ ] `npx vitest run src/lib/foreman/ src/app/api/v1/orgs/**/foreman/**` + `npx tsc --noEmit` clean.
- [ ] Manual PR → CI green (`check` + `Config assertions`) → `gh pr merge --squash --admin` → tag `vX.Y.Z` → `deploy-apponly.sh X.Y.Z` (foreman self-mod = sensitive, never auto-ships).
- [ ] Post-deploy: set the DEFCON Demo org supervisor `mode = dry`, watch a pass in `journalctl`, review verdicts in the console preview, then flip `live`.

# Self-review (spec coverage)

- §Architecture (pure core + daemon glue) → Tasks 1–8. ✓
- §Four behaviors → `decideVerdict` (Task 4) + `executeVerdict` (Task 7). ✓
- §Safety rails: cap → Task 5; confidence gate + self-mod caution → Task 4; reversible/event-sourced/idempotent → Tasks 6–7; human-respect → Task 3; kill-switch/per-org → Tasks 9–11; inaction-on-failure → Task 7 (leave on judgment failure). ✓
- §UI config → Tasks 9–12; §observability (feed, dry preview, badge, undo) → Tasks 13–15. ✓
- §Rollout (dry→live) → Ship section. ✓
