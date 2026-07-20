# Foreman Durable Loop-Graph + Convergence Metrics (Approach B)

**Status:** Approved design (brainstorm complete 2026-07-20). Ready for implementation plan.
**Author:** Foreman platform work, session 0672174d.
**Related:** [[foreman-supervisor-epic]], the Loop Engineering 14-step analysis (scratchpad `foreman-loop-engineering-analysis.md`), [[foreman-control-flow-and-release-discipline]].

## 1. Goal

Replace `scripts/foreman/run.mts`'s implicit imperative per-ticket control flow — whose state is scattered across the in-memory `inflight` Map (+ its `phase` field), the `attempts` Map, `turnResumes`/`buildStart` locals inside `processOne`, the DB `columnKey`, and the SDK session/HOME — with **one typed, serializable, versioned `LoopState` per ticket**, driven by a **pure reducer** that embodies the Loop Engineering building blocks. Persist every transition to a durable log so that:

1. **Resume becomes "load state, continue"** — retiring the resume-fragility bug class *by construction* (the HOME/session bugs fixed earlier this session were symptoms of unserializable state).
2. **Every loop is replayable** by `(loopId, iteration)` for time-travel debugging.
3. **Convergence is measurable** — an evaluation harness aggregates a typed transition log into convergence-rate, iterations-to-converge, invariant-violation-rate, and cost-per-convergence, so we can *prove* the state-graph improved delivery rather than merely changed the code.

**Non-goal:** a rewrite from scratch, or adopting a durable-execution framework (Temporal/Inngest). Foreman already embodies ~8 of the framework's 14 steps; this closes the real gaps (Steps 2/3/7/8/10/11/13).

## 2. Architecture: target and route

**Target architecture** is the framework's five building blocks as named modules — `reduce(state, event) → state` with pure `observe` / `decideNext` / `classify` / `enforce` around a typed `LoopState`. That reducer engine IS the textbook embodiment of the framework's loop body: **Observe → Decide → Act → Enforce Invariants → Check Termination**.

**Route to it** is incremental extraction with shadow validation — the framework's own Step 14 (shadow → canary → registry) forbids big-banging a production loop, and Foreman ships its own code, so each building block is peeled out of `run.mts` one at a time, shipped, and validated before the engine ever drives a live build. The two are not in tension: the target is the engine; the route is incremental.

### 2.1 Pure core — `src/lib/foreman/loop/` (vitest-testable, zero IO)

Each file has one responsibility; all functions are pure (facts and budgets are passed in, never read from IO):

| File | Responsibility | Framework step |
|---|---|---|
| `state.ts` | `LoopState` type, `SCHEMA_VERSION`, `initialState(brief)`, `serialize`/`deserialize` with a version-migration hook | 2 |
| `observe.ts` | `observe(state, rawFacts) → Observation` — extract + prune the facts a decision needs (ticket, diff summary, park reasons, CI results) | 5 |
| `convergence.ts` | `classify(state) → { status: "running" \| Terminal, signal, reason }` — the single convergence contract | 3 |
| `invariants.ts` | `INVARIANTS: Invariant[]` registry (each `{ id, check, remediation }`) + `enforce(state, action) → InvariantResult[]` | 8 |
| `transitions.ts` | `decideNext(state, obs) → Action` — pure decision of the next phase/action | 1, 4 |
| `reduce.ts` | `reduce(state, event) → state` — pure, deterministic; the heart of the engine | 2, 7 |
| `metrics.ts` | pure aggregation of transition rows → convergence metrics | 11 |

### 2.2 IO / effects — `scripts/foreman/loop/` (`.mts`, imported as `.mjs`)

| File | Responsibility |
|---|---|
| `loop-io.mts` | `loadState(loopId)` / `saveState(state)` (upsert projection) / `appendTransition(t)` (append log) |
| `loop-driver.mts` | The loop: `load → observe → classify → (running? decideNext → executor performs effect → reduce → persist transition+state) → repeat`. In shadow mode it computes decisions and logs comparisons without acting. At end of cutover it replaces the `processOne` body. |
| `loop-mode.mts` | Reads per-org `ForemanLoopSettings` mode `off \| shadow \| live` + budgets |
| `metrics-io.mts` | Reads `ForemanLoopTransition` for the eval harness / console dashboard |

## 3. Data model (CQRS: append-only source-of-truth log + read projection)

Rationale: folding transition history into the generic `foreman_events` JSON blob would be self-limiting — a JSON column cannot be indexed or aggregated efficiently, and the convergence-metrics harness must run aggregate SQL over every transition. So the transition log is a dedicated, typed table.

### 3.1 `ForemanLoopTransition` — immutable append-only source of truth

```prisma
model ForemanLoopTransition {
  id                String   @id @default(cuid())
  loopId            String                 // = work item id (one loop per ticket)
  orgId             String
  iteration         Int                    // 0-based, monotonic per loop
  fromPhase         String
  toPhase           String
  action            String                 // the Action kind taken this transition
  terminationSignal String?                // set on the terminal transition
  invariantResults  Json                   // InvariantResult[]
  durationMs        Int
  tokensIn          Int      @default(0)
  tokensOut         Int      @default(0)
  costUsd           Float    @default(0)
  stateSnapshot     Json                   // full LoopState after this transition (for replay)
  createdAt         DateTime @default(now())

  @@unique([loopId, iteration])
  @@index([orgId, createdAt])
  @@index([loopId])
}
```

### 3.2 `ForemanLoopState` — read-optimized projection (rebuildable from the log)

```prisma
model ForemanLoopState {
  loopId       String   @id                // = work item id
  orgId        String
  status       String                      // "running" | terminal signal
  phase        String                      // denormalized current phase (cheap board queries)
  iteration    Int
  schemaVersion Int
  state        Json                        // serialized LoopState
  updatedAt    DateTime @updatedAt
  createdAt    DateTime @default(now())

  @@index([orgId, status])
}
```

### 3.3 `ForemanLoopSettings` — per-org control (mirrors supervisor `off/shadow/live`)

```prisma
model ForemanLoopSettings {
  id             String   @id @default(cuid())
  orgId          String?  @unique           // null = project-wide default; org rows override
  mode           String   @default("off")   // "off" | "shadow" | "live"
  wallClockMin   Int      @default(90)       // budget: wall-clock minutes per loop
  costUsdCeiling Float?                       // budget: optional cost ceiling (Step 13-ready)
  stallRounds    Int      @default(3)         // no-progress transitions before `stall`
  updatedAt      DateTime @updatedAt
}
```

Project-wide (`orgId = null`) rows require platform admin to edit (same guard the harness uses); org rows are per-org and additive. Note `@@unique` on a nullable column treats NULLs as distinct, so project-wide-row uniqueness is enforced app-side (established pattern in this codebase).

## 4. `LoopState` shape (Step 2)

```ts
type Phase =
  | "queued" | "building" | "resuming" | "checking" | "repairing"
  | "reviewing" | "shipping" | "parked" | "done";

type TerminationSignal =
  | "shipped" | "parked_for_human" | "stall"
  | "iteration_cap" | "budget_exhausted" | "fatal";

interface LoopState {
  schemaVersion: number;
  loopId: string;                 // work item id
  orgId: string;
  brief: TicketBrief;             // ticket key/title/description/triage
  phase: Phase;
  iteration: number;
  attempts: number;               // build attempts (was the `attempts` Map)
  turnResumes: number;            // segment count (was the local var)
  startedAtMs: number;            // wall-clock anchor (was `buildStart`)
  sessionRef: string | null;      // SDK resume session id (was scattered in HOME)
  worktreeRef: string | null;
  sha: string | null;             // last commit produced
  lastDiffHash: string | null;    // for stall detection
  lastCheckSignature: string | null; // for stall detection (failing check identity)
  noProgressRounds: number;       // increments when diff+check unchanged
  invariantResults: InvariantResult[];
  costUsd: number;
  terminationSignal: TerminationSignal | null;
  terminationReason: string | null;
}
```

**The serialization test (Step 2's litmus):** `deserialize(serialize(s))` must round-trip, and the driver must be able to `loadState` and continue from any `stateSnapshot` — "if you can't serialize it to JSON and replay from iteration N, it's not state, it's hope." Every field above is plain JSON; there are no live handles (worktree/session are *references*, re-materialized by the driver).

## 5. Convergence contract (Step 3)

A single pure predicate replaces the scattered `MAX_ATTEMPTS` / `MAX_TURN_RESUMES` / `BUILD_BUDGET_MS` / breaker checks:

```ts
function classify(state: LoopState, now: number): { status: "running" | "terminal"; signal?: TerminationSignal; reason: string };
```

Closed terminal set:

| Signal | Condition | Routes to |
|---|---|---|
| `shipped` | checks passed + PR queued/merged | `done` |
| `parked_for_human` | needs input/approval (valid handoff, Step 12) | `review` + escalate |
| `stall` | `noProgressRounds >= stallRounds` (diff + failing-check unchanged) — **new** | `parked` w/ diagnosis |
| `iteration_cap` | `attempts >= MAX_ATTEMPTS` or `turnResumes >= MAX_TURN_RESUMES` | `parked` |
| `budget_exhausted` | `now - startedAtMs > wallClockMin` **or** `costUsd > costUsdCeiling` — **new: pluggable** | `parked` |
| `fatal` | unrecoverable (worktree/auth/infra) | `parked` + alert |

The two new detectors: **`stall`** (Foreman today keeps iterating when not converging; this catches it) and a **pluggable budget** (wall-clock now; `costUsd` ceiling makes Step 13 per-loop-type spend caps a config change, not a refactor).

## 6. Idempotent executor (Step 7)

Every action is keyed `(loopId, iteration)`. Before performing an effect, the executor checks the transition log: if iteration N already recorded that action, re-applying is a no-op. So a crash-resume never double-commits or double-ships. `ensurePr` already edits-in-place (C124); commits and `moveColumn` become iteration-keyed. This is what makes "load state, continue" safe under restart.

## 7. Invariant registry (Step 8)

`INVARIANTS: Invariant[]`, each entry:

```ts
interface Invariant {
  id: string;                                   // e.g. "changelog-required", "no-sensitive-paths"
  check(ctx: { state: LoopState; action: Action; diff?: string }): InvariantResult; // pure, code not model
  remediation: (r: InvariantResult) => Action | "escalate"; // every invariant self-heals or escalates
}
```

Folds today's scattered guardrails (changelog rule now in the harness hook, risk-gate sensitive paths, CI-gate, reviewer verdict) into one named set. "Every invariant has a remediation, not just a failure." The repair loop already does this ad-hoc; this formalizes it.

## 8. Evaluation harness (Step 11) — ships alongside

`metrics.ts` (pure) aggregates `ForemanLoopTransition` rows:

- **convergence-rate** = loops reaching `shipped` without a `parked_for_human` detour ÷ total loops.
- **iterations-to-converge** = mean/p50/p95 `iteration` at the `shipped` transition.
- **invariant-violation-rate** = transitions with a failing `invariantResults` entry ÷ total.
- **cost-per-convergence** = Σ`costUsd` ÷ shipped loops (and per-loop-type once loop-types multiply).

Surfaced in a console dashboard card (per-org + project-wide), reading via `metrics-io.mts`. This is how "is Foreman getting better or worse?" becomes measurable — the prerequisite for scaling trust and, later, per-loop convergence SLAs (Step 14).

## 9. Cutover: Record → shadow → canary (nothing changes behavior until the end)

The most production-grade / predictable path — evidence before the engine touches a live build:

1. **Schema** — 3 tables + migration (`deploy-migrate`).
2. **Pure core** — all seven core modules, fully unit-tested, no wiring (daemon has no behavior change).
3. **Record-only** — the driver writes `ForemanLoopState` + `ForemanLoopTransition` *alongside* the untouched `processOne`. Pure additive; zero behavior change; the eval harness starts receiving real data immediately.
4. **Eval harness + dashboard** — metrics over the transition log.
5. **Shadow** — at each real transition the engine's `classify` / `decideNext` are computed, logged, and compared to what the imperative code actually did; the **agreement rate** is the empirical validation gate.
6. **Live canary** — the per-org `ForemanLoopSettings.mode` flag hands *driving* to the engine; `processOne` becomes a thin wrapper over `loop-driver`. **DEFCON Demo org first** as canary, then the rest.

Each phase is an independently shippable PR. Pure-core/driver phases are daemon-only (merge + foreman restart); schema/UI phases go via manual `--admin` + `deploy-migrate`, fitting Foreman's self-mod release discipline (self-modifying code is a sensitive path per `risk.ts` and never auto-ships).

## 10. Testing strategy

- **Pure core (vitest):** `serialize`/`deserialize` round-trip + replay-from-snapshot; `classify` signal matrix (every terminal condition + running); stall detection (diff+check unchanged N rounds); invariant registry + each remediation; `reduce` determinism (same state+event → same next state); idempotent-executor no-op-on-reapply.
- **Shadow-agreement rate:** computed from real builds during Phase 5; the gate before any live flip (target threshold set at Phase 5, e.g. agreement ≥ 95% over ≥ N loops).
- **Metrics:** computed from real transition rows; dashboard values spot-checked against journald for a sample of loops.
- No new e2e infra; the driver's IO seams (`loadState`/`saveState`/`appendTransition`) are the only mocked boundaries.

## 11. Risks and mitigations

- **Divergence between engine and imperative code goes unnoticed** → Phase 5 shadow-agreement gate makes divergence a measured number, not a surprise.
- **Schema migration on a live daemon** → daemon runs `tsx` from the checkout; migration deploys via `deploy-migrate` before the daemon reads the new tables; record-only phase tolerates empty tables.
- **Double-acting on crash-resume** → the idempotent executor (Step 7) keyed by `(loopId, iteration)`.
- **State-schema evolution** → `schemaVersion` + `deserialize` migration hook; old snapshots remain replayable.
- **Scope creep into Steps 9/14** (long-term build memory, loop registry/SLAs) → explicitly deferred to follow-on epics; this spec stops at a single well-instrumented build loop + its metrics.

## 12. Out of scope (explicit)

- Long-term build-outcome memory / semantic recall (Step 9) — later epic.
- Multi-loop registry + per-loop convergence SLAs + canary framework generalization (Step 14) — later epic; the supervisor's dry/live already demonstrates the shadow pattern.
- Migrating the supervisor or planner loops onto the engine — this spec covers the build loop only; the engine is designed to accept them later.
