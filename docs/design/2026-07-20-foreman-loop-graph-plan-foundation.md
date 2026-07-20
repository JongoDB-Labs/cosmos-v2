# Foreman Loop-Graph — Foundation Plan (Phases 1–2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the schema + the pure, fully-unit-tested reducer core for Foreman's durable loop-graph — with zero wiring into the live daemon.

**Architecture:** A hub-and-spoke pure core in `src/lib/foreman/loop/`: `state.ts` holds every shared type (`LoopState`, `Phase`, `TerminationSignal`, `Action`, `Event`, `Observation`, `InvariantResult`) plus state constructors/serialization; the behavior modules (`convergence`, `invariants`, `observe`, `transitions`, `reduce`) are pure functions over those types. No IO — facts and budgets are passed in. Three Prisma models back the eventual persistence but are unused by this plan's code (additive schema only).

**Tech Stack:** TypeScript, Prisma (Postgres), vitest (`// @vitest-environment node`), the existing `src/lib/foreman/` pure-core seam.

## Global Constraints

- Pure core lives in `src/lib/foreman/` (or a `loop/` subdir under it) and imports **no** IO — every fact/budget is a function argument. Verbatim from spec §2.1.
- Tests are colocated `*.test.ts` next to each module, first line `// @vitest-environment node`, `import { describe, it, expect } from "vitest"`. (Codebase convention.)
- `LoopState` must be plain-JSON serializable: no live handles — worktree/session are string **references**. Verbatim from spec §4. `deserialize(serialize(s))` must round-trip.
- Invariants **wrap existing** pure logic, never reimplement it: `classifyRisk` from `src/lib/foreman/risk.ts` and `shouldDenyCommit` from `src/lib/foreman/harness.ts`. (DRY; spec §7.)
- Prisma models follow the codebase convention: `@id @default(dbgenerated("gen_random_uuid()")) @db.Uuid`, snake_case `@map`/`@@map`, `orgId` nullable (`String?`) for the project-wide default row (like the harness models). No `Organization` relation on these operational tables (FK-less `orgId` scalar, minimizing back-relation churn).
- `SCHEMA_VERSION = 1`. Terminal signal set is closed: `shipped | parked_for_human | stall | iteration_cap | budget_exhausted | fatal`. Verbatim from spec §4/§5.
- This plan is **Phase 1 (schema)** = its own PR shipped via `--admin` + `deploy-migrate`; **Phase 2 (pure core, Tasks 2–7)** = one daemon-only PR after all tests pass. Both are additive with zero behavior change. Foreman self-mod is a sensitive path (never auto-ships).

---

## File Structure

- `prisma/schema.prisma` — add 3 models (Task 1).
- `prisma/migrations/<ts>_foreman_loop_graph/migration.sql` — generated (Task 1).
- `src/lib/foreman/loop/state.ts` + `state.test.ts` — types, `initialState`, `serialize`/`deserialize`, `SCHEMA_VERSION`, `hashString` (Task 2).
- `src/lib/foreman/loop/convergence.ts` + `.test.ts` — `classify`, `Budgets`, `Verdict` (Task 3).
- `src/lib/foreman/loop/invariants.ts` + `.test.ts` — `Invariant`, `INVARIANTS`, `enforce` (Task 4).
- `src/lib/foreman/loop/observe.ts` + `.test.ts` — `RawFacts`, `Observation`, `observe` (Task 5).
- `src/lib/foreman/loop/transitions.ts` + `.test.ts` — `decideNext` (Task 6).
- `src/lib/foreman/loop/reduce.ts` + `.test.ts` — `reduce` (Task 7).

---

### Task 1: Prisma schema — 3 loop models + migration

**Files:**
- Modify: `prisma/schema.prisma` (append 3 models)
- Create: `prisma/migrations/<timestamp>_foreman_loop_graph/migration.sql` (generated)

**Interfaces:**
- Produces: tables `foreman_loop_transition`, `foreman_loop_state`, `foreman_loop_settings`; regenerated Prisma client with `ForemanLoopTransition` / `ForemanLoopState` / `ForemanLoopSettings` delegates. No code in this plan reads them (additive only).

- [ ] **Step 1: Append the three models to `prisma/schema.prisma`**

```prisma
model ForemanLoopTransition {
  id                String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  loopId            String   @map("loop_id") @db.Uuid
  orgId             String   @map("org_id") @db.Uuid
  iteration         Int
  fromPhase         String   @map("from_phase")
  toPhase           String   @map("to_phase")
  action            String
  terminationSignal String?  @map("termination_signal")
  invariantResults  Json     @map("invariant_results")
  durationMs        Int      @map("duration_ms")
  tokensIn          Int      @default(0) @map("tokens_in")
  tokensOut         Int      @default(0) @map("tokens_out")
  costUsd           Float    @default(0) @map("cost_usd")
  stateSnapshot     Json     @map("state_snapshot")
  createdAt         DateTime @default(now()) @map("created_at")

  @@unique([loopId, iteration])
  @@index([orgId, createdAt])
  @@index([loopId])
  @@map("foreman_loop_transition")
}

model ForemanLoopState {
  loopId        String   @id @map("loop_id") @db.Uuid
  orgId         String   @map("org_id") @db.Uuid
  status        String
  phase         String
  iteration     Int
  schemaVersion Int      @map("schema_version")
  state         Json
  updatedAt     DateTime @updatedAt @map("updated_at")
  createdAt     DateTime @default(now()) @map("created_at")

  @@index([orgId, status])
  @@map("foreman_loop_state")
}

model ForemanLoopSettings {
  id             String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String?  @unique @map("org_id") @db.Uuid
  mode           String   @default("off")
  wallClockMin   Int      @default(90) @map("wall_clock_min")
  costUsdCeiling Float?   @map("cost_usd_ceiling")
  stallRounds    Int      @default(3) @map("stall_rounds")
  updatedById    String?  @map("updated_by_id") @db.Uuid
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  @@map("foreman_loop_settings")
}
```

- [ ] **Step 2: Generate the migration (create-only) and the client**

Run: `npx prisma migrate dev --name foreman_loop_graph --create-only && npx prisma generate`
Expected: a new `prisma/migrations/<timestamp>_foreman_loop_graph/migration.sql` with three `CREATE TABLE` statements + indexes; client regenerates with no type errors.

- [ ] **Step 3: Verify the migration SQL is sane**

Run: `grep -c "CREATE TABLE" prisma/migrations/*_foreman_loop_graph/migration.sql`
Expected: `3`

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "schema|prisma" | head`
Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(foreman): loop-graph schema (transition log + state projection + settings)"
```

> **Ship note:** Task 1 is Phase 1 — its own PR, merged `--admin` + applied via `deploy-migrate.sh`. The daemon does not read these tables yet.

---

### Task 2: `state.ts` — types, initialState, serialization

**Files:**
- Create: `src/lib/foreman/loop/state.ts`
- Test: `src/lib/foreman/loop/state.test.ts`

**Interfaces:**
- Consumes: `TicketBrief` from `@/lib/foreman/prompt`.
- Produces: `SCHEMA_VERSION: number`; types `Phase`, `TerminationSignal`, `InvariantResult`, `Action`, `Event`, `Observation`, `LoopState`; functions `initialState(loopId, orgId, brief, nowMs): LoopState`, `serialize(s): LoopState`, `deserialize(raw: unknown): LoopState`, `hashString(s: string): string`.

- [ ] **Step 1: Write the failing test** (`state.test.ts`)

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { initialState, serialize, deserialize, hashString, SCHEMA_VERSION } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "COSMOS-1", title: "t", description: "d", classification: "FEATURE", acceptanceCriteria: ["a"] };

describe("initialState", () => {
  it("starts queued at iteration 0 with no live handles", () => {
    const s = initialState("00000000-0000-0000-0000-000000000001", "org1", brief, 1000);
    expect(s.phase).toBe("queued");
    expect(s.iteration).toBe(0);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.sessionRef).toBeNull();
    expect(s.startedAtMs).toBe(1000);
  });
});

describe("serialize/deserialize", () => {
  it("round-trips through JSON with no loss", () => {
    const s = initialState("id", "org1", brief, 1000);
    const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
    expect(back).toEqual(s);
  });
  it("stamps an older-version blob up to the current SCHEMA_VERSION", () => {
    const s = initialState("id", "org1", brief, 1000);
    const old = { ...s, schemaVersion: 0 };
    expect(deserialize(old).schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("hashString", () => {
  it("is deterministic and differs for different inputs", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/foreman/loop/state.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `state.ts`**

```ts
import type { TicketBrief } from "@/lib/foreman/prompt";

export const SCHEMA_VERSION = 1;

/** Superset of the daemon's InFlightBuild phases plus lifecycle-terminal phases. */
export type Phase =
  | "queued" | "building" | "resuming" | "checks" | "repair"
  | "review" | "shipping" | "parked" | "done";

export type TerminationSignal =
  | "shipped" | "parked_for_human" | "stall"
  | "iteration_cap" | "budget_exhausted" | "fatal";

/** One invariant's outcome for a transition (see invariants.ts). */
export interface InvariantResult {
  id: string;
  ok: boolean;
  detail: string;
  remediation: string | null; // null when ok
}

/** What the driver should DO next — decideNext's output. Carries no IO payloads. */
export type Action =
  | { kind: "build" }
  | { kind: "resume" }
  | { kind: "run_checks" }
  | { kind: "repair" }
  | { kind: "review" }
  | { kind: "ship" }
  | { kind: "park"; signal: TerminationSignal; reason: string }
  | { kind: "noop" };

/** The OUTCOME of an executed action, fed into reduce(). */
export type Event =
  | { kind: "build_done"; sha: string | null; sessionRef: string | null; costUsd: number; turnOverflow: boolean }
  | { kind: "checks_done"; passed: boolean; signature: string | null }
  | { kind: "repair_done"; sha: string | null; costUsd: number }
  | { kind: "review_done"; approved: boolean; reason: string }
  | { kind: "shipped"; version: string }
  | { kind: "parked"; signal: TerminationSignal; reason: string }
  | { kind: "fatal"; reason: string };

/** Extracted, pruned facts a decision needs — observe.ts's output. */
export interface Observation {
  hasDiff: boolean;
  diffHash: string | null;
  checksPassed: boolean | null; // null = not run this iteration
  checkSignature: string | null;
  progressed: boolean;
  needsHumanInput: boolean;
}

/** The single typed, serializable, replayable per-ticket loop state (spec §4). */
export interface LoopState {
  schemaVersion: number;
  loopId: string;
  orgId: string;
  brief: TicketBrief;
  phase: Phase;
  iteration: number;
  attempts: number;
  turnResumes: number;
  startedAtMs: number;
  sessionRef: string | null;
  worktreeRef: string | null;
  sha: string | null;
  lastDiffHash: string | null;
  lastCheckSignature: string | null;
  noProgressRounds: number;
  invariantResults: InvariantResult[];
  costUsd: number;
  terminationSignal: TerminationSignal | null;
  terminationReason: string | null;
}

export function initialState(loopId: string, orgId: string, brief: TicketBrief, nowMs: number): LoopState {
  return {
    schemaVersion: SCHEMA_VERSION,
    loopId, orgId, brief,
    phase: "queued",
    iteration: 0,
    attempts: 0,
    turnResumes: 0,
    startedAtMs: nowMs,
    sessionRef: null,
    worktreeRef: null,
    sha: null,
    lastDiffHash: null,
    lastCheckSignature: null,
    noProgressRounds: 0,
    invariantResults: [],
    costUsd: 0,
    terminationSignal: null,
    terminationReason: null,
  };
}

/** Explicit serialization seam (LoopState is already JSON-safe; this documents the boundary). */
export function serialize(state: LoopState): LoopState {
  return { ...state };
}

/** Load persisted state, running forward migrations to the current SCHEMA_VERSION. */
export function deserialize(raw: unknown): LoopState {
  const o = { ...(raw as Record<string, unknown>) };
  // Future: chain version migrations here when SCHEMA_VERSION advances.
  o.schemaVersion = SCHEMA_VERSION;
  return o as unknown as LoopState;
}

/** Deterministic, dependency-free djb2 hash → hex. NEVER uses randomness (replay-safe). */
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/foreman/loop/state.test.ts`
Expected: PASS (3 describes green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/loop/state.ts src/lib/foreman/loop/state.test.ts
git commit -m "feat(foreman): loop-graph state types + serialization core"
```

---

### Task 3: `convergence.ts` — the convergence contract

**Files:**
- Create: `src/lib/foreman/loop/convergence.ts`
- Test: `src/lib/foreman/loop/convergence.test.ts`

**Interfaces:**
- Consumes: `LoopState`, `TerminationSignal` from `./state`.
- Produces: `interface Budgets { wallClockMs: number; costUsdCeiling: number | null; stallRounds: number; maxAttempts: number; maxTurnResumes: number }`; `interface Verdict { status: "running" | "terminal"; signal?: TerminationSignal; reason: string }`; `classify(state: LoopState, now: number, b: Budgets): Verdict`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { classify, type Budgets } from "./convergence";
import { initialState } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "C-1", title: "t", description: "", classification: "BUG", acceptanceCriteria: [] };
const B: Budgets = { wallClockMs: 60_000, costUsdCeiling: 5, stallRounds: 3, maxAttempts: 3, maxTurnResumes: 30 };
const base = () => initialState("id", "o", brief, 0);

describe("classify", () => {
  it("is running for a fresh state within budget", () => {
    expect(classify({ ...base(), phase: "building" }, 1000, B).status).toBe("running");
  });
  it("returns budget_exhausted past the wall-clock", () => {
    const v = classify({ ...base(), phase: "building" }, 61_000, B);
    expect(v).toMatchObject({ status: "terminal", signal: "budget_exhausted" });
  });
  it("returns budget_exhausted past the cost ceiling", () => {
    const v = classify({ ...base(), phase: "building", costUsd: 6 }, 1000, B);
    expect(v).toMatchObject({ status: "terminal", signal: "budget_exhausted" });
  });
  it("returns iteration_cap at maxAttempts", () => {
    const v = classify({ ...base(), phase: "building", attempts: 3 }, 1000, B);
    expect(v).toMatchObject({ status: "terminal", signal: "iteration_cap" });
  });
  it("returns iteration_cap at maxTurnResumes", () => {
    const v = classify({ ...base(), phase: "resuming", turnResumes: 30 }, 1000, B);
    expect(v).toMatchObject({ status: "terminal", signal: "iteration_cap" });
  });
  it("returns stall once noProgressRounds hits stallRounds", () => {
    const v = classify({ ...base(), phase: "repair", noProgressRounds: 3 }, 1000, B);
    expect(v).toMatchObject({ status: "terminal", signal: "stall" });
  });
  it("surfaces an already-parked terminal state", () => {
    const v = classify({ ...base(), phase: "parked", terminationSignal: "parked_for_human", terminationReason: "needs input" }, 1000, B);
    expect(v).toMatchObject({ status: "terminal", signal: "parked_for_human" });
  });
  it("surfaces a shipped/done state", () => {
    const v = classify({ ...base(), phase: "done" }, 1000, B);
    expect(v).toMatchObject({ status: "terminal", signal: "shipped" });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/lib/foreman/loop/convergence.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `convergence.ts`**

```ts
import type { LoopState, TerminationSignal } from "./state";

export interface Budgets {
  wallClockMs: number;
  costUsdCeiling: number | null;
  stallRounds: number;
  maxAttempts: number;
  maxTurnResumes: number;
}

export interface Verdict {
  status: "running" | "terminal";
  signal?: TerminationSignal;
  reason: string;
}

/** The single convergence contract (spec §5). Replaces the scattered
 *  MAX_ATTEMPTS / MAX_TURN_RESUMES / BUILD_BUDGET_MS / breaker checks. */
export function classify(state: LoopState, now: number, b: Budgets): Verdict {
  // Already-recorded terminal phases win first (idempotent on re-eval).
  if (state.phase === "done")
    return { status: "terminal", signal: "shipped", reason: state.terminationReason ?? "shipped" };
  if (state.phase === "parked")
    return { status: "terminal", signal: state.terminationSignal ?? "parked_for_human", reason: state.terminationReason ?? "parked" };

  // Budget: wall-clock or cost.
  if (now - state.startedAtMs > b.wallClockMs)
    return { status: "terminal", signal: "budget_exhausted", reason: `wall-clock ${Math.round((now - state.startedAtMs) / 60_000)}m exceeded budget` };
  if (b.costUsdCeiling != null && state.costUsd > b.costUsdCeiling)
    return { status: "terminal", signal: "budget_exhausted", reason: `cost $${state.costUsd.toFixed(2)} exceeded ceiling $${b.costUsdCeiling.toFixed(2)}` };

  // Iteration caps.
  if (state.attempts >= b.maxAttempts)
    return { status: "terminal", signal: "iteration_cap", reason: `${state.attempts} attempts (cap ${b.maxAttempts})` };
  if (state.turnResumes >= b.maxTurnResumes)
    return { status: "terminal", signal: "iteration_cap", reason: `${state.turnResumes} turn-resumes (cap ${b.maxTurnResumes})` };

  // Stall: no progress across N rounds.
  if (state.noProgressRounds >= b.stallRounds)
    return { status: "terminal", signal: "stall", reason: `no progress across ${state.noProgressRounds} rounds` };

  return { status: "running", reason: "converging" };
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npx vitest run src/lib/foreman/loop/convergence.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/loop/convergence.ts src/lib/foreman/loop/convergence.test.ts
git commit -m "feat(foreman): loop-graph convergence contract (classify)"
```

---

### Task 4: `invariants.ts` — named invariant registry (wraps existing guardrails)

**Files:**
- Create: `src/lib/foreman/loop/invariants.ts`
- Test: `src/lib/foreman/loop/invariants.test.ts`

**Interfaces:**
- Consumes: `Action`, `InvariantResult`, `LoopState` from `./state`; `classifyRisk`, `DiffSummary` from `@/lib/foreman/risk`; `shouldDenyCommit` from `@/lib/foreman/harness`.
- Produces: `interface InvariantContext { state: LoopState; action: Action; diff?: DiffSummary; commit?: { command: string; pkgVersion: string; changelogTopVersion: string } }`; `interface Invariant { id: string; check(ctx: InvariantContext): InvariantResult }`; `const INVARIANTS: Invariant[]`; `enforce(ctx: InvariantContext): InvariantResult[]`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { enforce, INVARIANTS, type InvariantContext } from "./invariants";
import { initialState, type Action } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "C-1", title: "t", description: "", classification: "BUG", acceptanceCriteria: [] };
const ctx = (over: Partial<InvariantContext>): InvariantContext => ({
  state: initialState("id", "o", brief, 0),
  action: { kind: "run_checks" } as Action,
  ...over,
});

describe("INVARIANTS registry", () => {
  it("every invariant supplies a remediation when it fails", () => {
    // A shipping action over a sensitive diff must fail with a non-null remediation.
    const results = enforce(ctx({ action: { kind: "ship" }, diff: { files: ["src/lib/foreman/run.mts"], additions: 1, deletions: 0 } }));
    const sensitive = results.find((r) => r.id === "sensitive-path-review")!;
    expect(sensitive.ok).toBe(false);
    expect(sensitive.remediation).not.toBeNull();
  });
  it("passes sensitive-path when shipping a safe diff", () => {
    const results = enforce(ctx({ action: { kind: "ship" }, diff: { files: ["src/app/page.tsx"], additions: 2, deletions: 1 } }));
    expect(results.find((r) => r.id === "sensitive-path-review")!.ok).toBe(true);
  });
  it("fails changelog-required on a version bump without a changelog entry", () => {
    const results = enforce(ctx({ commit: { command: "git commit -m x", pkgVersion: "2.99.0", changelogTopVersion: "2.98.0" } }));
    expect(results.find((r) => r.id === "changelog-required")!.ok).toBe(false);
  });
  it("is a no-op (all ok) when no commit and not shipping", () => {
    const results = enforce(ctx({}));
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/lib/foreman/loop/invariants.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `invariants.ts`**

```ts
import { classifyRisk, type DiffSummary } from "@/lib/foreman/risk";
import { shouldDenyCommit } from "@/lib/foreman/harness";
import type { Action, InvariantResult, LoopState } from "./state";

export interface InvariantContext {
  state: LoopState;
  action: Action;
  diff?: DiffSummary;
  commit?: { command: string; pkgVersion: string; changelogTopVersion: string };
}

export interface Invariant {
  id: string;
  check(ctx: InvariantContext): InvariantResult;
}

/** Unified named guardrail set (spec §7). Each entry wraps an EXISTING pure check
 *  and carries a remediation — "every invariant self-heals or escalates, never
 *  just fails." Do not reimplement risk/changelog logic here. */
export const INVARIANTS: Invariant[] = [
  {
    id: "changelog-required",
    check({ commit }) {
      if (!commit) return { id: "changelog-required", ok: true, detail: "no commit this transition", remediation: null };
      const deny = shouldDenyCommit(commit.command, commit.pkgVersion, commit.changelogTopVersion);
      return deny
        ? { id: "changelog-required", ok: false, detail: `version bump to ${commit.pkgVersion} without a matching changelog entry`, remediation: `Add a CHANGELOG entry for ${commit.pkgVersion} before committing.` }
        : { id: "changelog-required", ok: true, detail: "changelog matches package version", remediation: null };
    },
  },
  {
    id: "sensitive-path-review",
    check({ action, diff }) {
      if (action.kind !== "ship" || !diff) return { id: "sensitive-path-review", ok: true, detail: "not auto-shipping / no diff", remediation: null };
      const r = classifyRisk(diff);
      return r.gated
        ? { id: "sensitive-path-review", ok: false, detail: r.reasons.join("; "), remediation: "Park for human approval instead of auto-shipping." }
        : { id: "sensitive-path-review", ok: true, detail: "diff is auto-ship-safe", remediation: null };
    },
  },
];

export function enforce(ctx: InvariantContext): InvariantResult[] {
  return INVARIANTS.map((inv) => inv.check(ctx));
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npx vitest run src/lib/foreman/loop/invariants.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/loop/invariants.ts src/lib/foreman/loop/invariants.test.ts
git commit -m "feat(foreman): loop-graph invariant registry wrapping risk + changelog checks"
```

---

### Task 5: `observe.ts` — observation function

**Files:**
- Create: `src/lib/foreman/loop/observe.ts`
- Test: `src/lib/foreman/loop/observe.test.ts`

**Interfaces:**
- Consumes: `LoopState`, `Observation` from `./state`; `hashString` from `./state`.
- Produces: `interface RawFacts { diff: string | null; checksPassed: boolean | null; checkLog: string | null; needsHumanInput: boolean }`; `observe(state: LoopState, facts: RawFacts): Observation`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { observe, type RawFacts } from "./observe";
import { initialState } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "C-1", title: "t", description: "", classification: "BUG", acceptanceCriteria: [] };
const facts = (o: Partial<RawFacts>): RawFacts => ({ diff: null, checksPassed: null, checkLog: null, needsHumanInput: false, ...o });

describe("observe", () => {
  it("reports progressed when the diff hash differs from last iteration", () => {
    const s = { ...initialState("id", "o", brief, 0), lastDiffHash: "old" };
    const obs = observe(s, facts({ diff: "new code" }));
    expect(obs.hasDiff).toBe(true);
    expect(obs.progressed).toBe(true);
  });
  it("reports NOT progressed when diff hash and check signature are unchanged", () => {
    const first = observe(initialState("id", "o", brief, 0), facts({ diff: "x", checkLog: "err at line 1" }));
    const s = { ...initialState("id", "o", brief, 0), lastDiffHash: first.diffHash, lastCheckSignature: first.checkSignature };
    const obs = observe(s, facts({ diff: "x", checkLog: "err at line 1" }));
    expect(obs.progressed).toBe(false);
  });
  it("passes through needsHumanInput and checksPassed", () => {
    const obs = observe(initialState("id", "o", brief, 0), facts({ checksPassed: true, needsHumanInput: true }));
    expect(obs.checksPassed).toBe(true);
    expect(obs.needsHumanInput).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/lib/foreman/loop/observe.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `observe.ts`**

```ts
import { hashString, type LoopState, type Observation } from "./state";

/** Raw facts the driver gathers via IO and hands to the pure observer. */
export interface RawFacts {
  diff: string | null;          // current working diff (null = none)
  checksPassed: boolean | null; // null = checks not run this iteration
  checkLog: string | null;      // check output when run
  needsHumanInput: boolean;     // a clarity/approval gate fired
}

/** Extract + prune facts into an Observation, computing progress vs. last iteration
 *  for stall detection (spec §5). Pure: no IO, deterministic. */
export function observe(state: LoopState, facts: RawFacts): Observation {
  const diffHash = facts.diff ? hashString(facts.diff) : null;
  const checkSignature = facts.checkLog ? hashString(normalizeLog(facts.checkLog)) : null;
  const progressed = diffHash !== state.lastDiffHash || checkSignature !== state.lastCheckSignature;
  return {
    hasDiff: !!facts.diff,
    diffHash,
    checksPassed: facts.checksPassed,
    checkSignature,
    progressed,
    needsHumanInput: facts.needsHumanInput,
  };
}

/** Reduce a check log to its failure identity: keep error-ish lines, drop volatile
 *  noise (timestamps, paths with line/col) so the same failure hashes stably. */
function normalizeLog(log: string): string {
  return log
    .split("\n")
    .filter((l) => /error|fail|✕|✗|expected|assert/i.test(l))
    .map((l) => l.replace(/:\d+:\d+/g, "").replace(/\d{2}:\d{2}:\d{2}/g, "").trim())
    .join("\n");
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npx vitest run src/lib/foreman/loop/observe.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/loop/observe.ts src/lib/foreman/loop/observe.test.ts
git commit -m "feat(foreman): loop-graph observation function with stall-progress detection"
```

---

### Task 6: `transitions.ts` — decideNext

**Files:**
- Create: `src/lib/foreman/loop/transitions.ts`
- Test: `src/lib/foreman/loop/transitions.test.ts`

**Interfaces:**
- Consumes: `LoopState`, `Observation`, `Action` from `./state`.
- Produces: `decideNext(state: LoopState, obs: Observation): Action`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { decideNext } from "./transitions";
import { initialState, type Observation } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "C-1", title: "t", description: "", classification: "BUG", acceptanceCriteria: [] };
const s = (phase: ReturnType<typeof initialState>["phase"]) => ({ ...initialState("id", "o", brief, 0), phase });
const obs = (o: Partial<Observation>): Observation => ({ hasDiff: false, diffHash: null, checksPassed: null, checkSignature: null, progressed: true, needsHumanInput: false, ...o });

describe("decideNext", () => {
  it("builds from queued", () => { expect(decideNext(s("queued"), obs({})).kind).toBe("build"); });
  it("runs checks after building", () => { expect(decideNext(s("building"), obs({})).kind).toBe("run_checks"); });
  it("reviews when checks passed", () => { expect(decideNext(s("checks"), obs({ checksPassed: true })).kind).toBe("review"); });
  it("repairs when checks failed", () => { expect(decideNext(s("checks"), obs({ checksPassed: false })).kind).toBe("repair"); });
  it("re-runs checks when not yet run", () => { expect(decideNext(s("checks"), obs({ checksPassed: null })).kind).toBe("run_checks"); });
  it("ships after a passing review", () => { expect(decideNext(s("review"), obs({})).kind).toBe("ship"); });
  it("parks for human input whenever needsHumanInput, regardless of phase", () => {
    const a = decideNext(s("building"), obs({ needsHumanInput: true }));
    expect(a).toMatchObject({ kind: "park", signal: "parked_for_human" });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/lib/foreman/loop/transitions.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `transitions.ts`**

```ts
import type { Action, LoopState, Observation } from "./state";

/** Pure decision of the next action given current phase + observation.
 *  The driver executes the Action's IO; this function chooses only. */
export function decideNext(state: LoopState, obs: Observation): Action {
  if (obs.needsHumanInput) return { kind: "park", signal: "parked_for_human", reason: "needs human input" };
  switch (state.phase) {
    case "queued":
      return { kind: "build" };
    case "building":
      return { kind: "run_checks" };
    case "resuming":
      return { kind: "run_checks" };
    case "checks":
      if (obs.checksPassed === true) return { kind: "review" };
      if (obs.checksPassed === false) return { kind: "repair" };
      return { kind: "run_checks" };
    case "repair":
      return { kind: "run_checks" };
    case "review":
      return { kind: "ship" };
    case "shipping":
    case "done":
    case "parked":
    default:
      return { kind: "noop" };
  }
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npx vitest run src/lib/foreman/loop/transitions.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/loop/transitions.ts src/lib/foreman/loop/transitions.test.ts
git commit -m "feat(foreman): loop-graph decideNext transition function"
```

---

### Task 7: `reduce.ts` — the reducer

**Files:**
- Create: `src/lib/foreman/loop/reduce.ts`
- Test: `src/lib/foreman/loop/reduce.test.ts`

**Interfaces:**
- Consumes: `LoopState`, `Event` from `./state`.
- Produces: `reduce(state: LoopState, event: Event): LoopState`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { reduce } from "./reduce";
import { initialState } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "C-1", title: "t", description: "", classification: "BUG", acceptanceCriteria: [] };
const base = () => initialState("id", "o", brief, 0);

describe("reduce", () => {
  it("is deterministic and immutable (same input → equal output, input untouched)", () => {
    const s = base();
    const a = reduce(s, { kind: "build_done", sha: "abc", sessionRef: "sess", costUsd: 1, turnOverflow: false });
    const b = reduce(s, { kind: "build_done", sha: "abc", sessionRef: "sess", costUsd: 1, turnOverflow: false });
    expect(a).toEqual(b);
    expect(s.phase).toBe("queued"); // original not mutated
  });
  it("build_done → checks, increments attempts, accumulates cost, records session", () => {
    const s = reduce(base(), { kind: "build_done", sha: "abc", sessionRef: "sess", costUsd: 2.5, turnOverflow: false });
    expect(s.phase).toBe("checks");
    expect(s.attempts).toBe(1);
    expect(s.costUsd).toBe(2.5);
    expect(s.sessionRef).toBe("sess");
    expect(s.iteration).toBe(1);
  });
  it("build_done with turnOverflow → resuming, increments turnResumes", () => {
    const s = reduce(base(), { kind: "build_done", sha: null, sessionRef: "sess", costUsd: 1, turnOverflow: true });
    expect(s.phase).toBe("resuming");
    expect(s.turnResumes).toBe(1);
  });
  it("checks_done passed → review, resets noProgressRounds", () => {
    const s = reduce({ ...base(), phase: "checks", noProgressRounds: 2 }, { kind: "checks_done", passed: true, signature: "sigA" });
    expect(s.phase).toBe("review");
    expect(s.noProgressRounds).toBe(0);
  });
  it("checks_done failed with the SAME signature → increments noProgressRounds (stall)", () => {
    const s = reduce({ ...base(), phase: "checks", lastCheckSignature: "sigA", noProgressRounds: 1 }, { kind: "checks_done", passed: false, signature: "sigA" });
    expect(s.phase).toBe("repair");
    expect(s.noProgressRounds).toBe(2);
  });
  it("checks_done failed with a NEW signature → resets noProgressRounds", () => {
    const s = reduce({ ...base(), phase: "checks", lastCheckSignature: "sigA", noProgressRounds: 2 }, { kind: "checks_done", passed: false, signature: "sigB" });
    expect(s.noProgressRounds).toBe(0);
  });
  it("review_done approved → shipping; rejected → repair", () => {
    expect(reduce({ ...base(), phase: "review" }, { kind: "review_done", approved: true, reason: "ok" }).phase).toBe("shipping");
    expect(reduce({ ...base(), phase: "review" }, { kind: "review_done", approved: false, reason: "no" }).phase).toBe("repair");
  });
  it("shipped → done with shipped signal; parked/fatal → parked with signal", () => {
    expect(reduce({ ...base(), phase: "shipping" }, { kind: "shipped", version: "2.99.0" })).toMatchObject({ phase: "done", terminationSignal: "shipped" });
    expect(reduce(base(), { kind: "parked", signal: "stall", reason: "stuck" })).toMatchObject({ phase: "parked", terminationSignal: "stall" });
    expect(reduce(base(), { kind: "fatal", reason: "worktree gone" })).toMatchObject({ phase: "parked", terminationSignal: "fatal" });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/lib/foreman/loop/reduce.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `reduce.ts`**

```ts
import type { Event, LoopState } from "./state";

/** Pure, deterministic state transition. Every transition increments `iteration`.
 *  Never mutates the input. This is the heart of the engine (spec §2, §6). */
export function reduce(state: LoopState, event: Event): LoopState {
  const base: LoopState = { ...state, iteration: state.iteration + 1 };
  switch (event.kind) {
    case "build_done": {
      const attempts = state.attempts + 1;
      const common = { ...base, sha: event.sha ?? base.sha, sessionRef: event.sessionRef, costUsd: base.costUsd + event.costUsd, attempts };
      return event.turnOverflow
        ? { ...common, turnResumes: state.turnResumes + 1, phase: "resuming" }
        : { ...common, phase: "checks" };
    }
    case "checks_done": {
      if (event.passed)
        return { ...base, lastCheckSignature: event.signature, noProgressRounds: 0, phase: "review" };
      const sameFailure = event.signature != null && event.signature === state.lastCheckSignature;
      return { ...base, lastCheckSignature: event.signature, noProgressRounds: sameFailure ? state.noProgressRounds + 1 : 0, phase: "repair" };
    }
    case "repair_done":
      return { ...base, sha: event.sha ?? base.sha, costUsd: base.costUsd + event.costUsd, phase: "checks" };
    case "review_done":
      return { ...base, phase: event.approved ? "shipping" : "repair" };
    case "shipped":
      return { ...base, phase: "done", terminationSignal: "shipped", terminationReason: `shipped ${event.version}` };
    case "parked":
      return { ...base, phase: "parked", terminationSignal: event.signal, terminationReason: event.reason };
    case "fatal":
      return { ...base, phase: "parked", terminationSignal: "fatal", terminationReason: event.reason };
  }
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npx vitest run src/lib/foreman/loop/reduce.test.ts` — Expected: PASS.

- [ ] **Step 5: Run the whole loop suite + typecheck**

Run: `npx vitest run src/lib/foreman/loop/ && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "loop/" | head`
Expected: all loop tests PASS; no tsc output for `loop/`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/foreman/loop/reduce.ts src/lib/foreman/loop/reduce.test.ts
git commit -m "feat(foreman): loop-graph reducer (reduce)"
```

---

## What this plan deliberately does NOT do (next plans)

- **No wiring into `run.mts`.** The record-only driver (`scripts/foreman/loop/{loop-io,loop-driver,loop-mode}.mts`) is Phase 3 — its own plan, written against these now-real interfaces.
- **No `metrics.ts` / dashboard.** The eval harness is Phase 4.
- **No shadow/live cutover.** Phases 5–6, planned once record-only data exists.

## Self-review notes

- **Spec coverage:** schema §3 → Task 1; `LoopState` §4 → Task 2; convergence contract §5 → Task 3; invariant registry §7 → Task 4; observation §2.1/§5 → Task 5; decision §2.1 → Task 6; reducer §2/§6 → Task 7. Idempotent executor (§6) and eval harness (§8) are downstream phases (noted).
- **Type consistency:** `Action`/`Event`/`Observation`/`InvariantResult`/`LoopState`/`Phase`/`TerminationSignal` are all defined once in `state.ts` (Task 2) and imported by Tasks 3–7 — no divergent redefinitions. `classify` reads only fields set by `reduce` (`attempts`, `turnResumes`, `noProgressRounds`, `costUsd`, `startedAtMs`, terminal phase/signal). `Budgets.maxAttempts/maxTurnResumes` mirror the daemon's current `MAX_ATTEMPTS=3` / `MAX_TURN_RESUMES=30`.
- **Placeholders:** none — every code step is complete.
