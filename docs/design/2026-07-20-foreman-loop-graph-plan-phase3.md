# Foreman Loop-Graph — Phase 3 Plan (Record-Only Instrumentation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Run the pure loop engine in **observer mode** alongside the untouched imperative `processOne` — translating the daemon's real phase transitions + outcomes into `Event`s, folding them through `reduce()`, and persisting `ForemanLoopState` + `ForemanLoopTransition` rows — with **zero behavior change**, so the eval harness (Phase 4) gets real data and the engine is validated against reality before it ever drives a build.

**Architecture:** A pure translation layer (`loop-translate.ts`) maps daemon phase/outcome signals → engine `Event`s; a thin per-org config reader (`loop-mode.mts`); a best-effort IO recorder (`loop-io.mts`) that folds events via the existing pure `reduce()` and upserts the projection + appends the transition log; and a small set of **best-effort, mode-gated** hooks in `run.mts` at the `setPhase` chokepoint, the lifecycle-begin `inFlightMeta.set`, and the terminal `record()` funnel. A hook throwing can never affect delivery.

**Tech Stack:** TypeScript, Prisma, vitest. Builds on the Phase 1–2 branch `feat/foreman-loop-foundation` (schema + pure core already committed).

## Global Constraints

- **Zero behavior change / additive-only.** Every hook is best-effort (wrapped to swallow all errors, mirroring `observe.ts`'s `track` → `trackStrict` split) and gated on per-org mode ∈ {`shadow`,`live`}; `off` (the default) records nothing. The imperative control flow is never altered — no early returns, no awaited blocking work on the delivery path. Verbatim from spec §9 phase 3.
- **Reuse the pure core, don't reimplement.** `loop-io`/`loop-driver` MUST build `LoopState` by calling the existing `initialState` + `reduce` from `@/lib/foreman/loop/state` + `reduce` — never hand-roll state transitions. That is the whole point (validate the engine against reality).
- **Mirror established patterns:** `loop-mode.mts` mirrors `src/lib/foreman/supervisor-settings.ts` (`findUnique` + safe default). `loop-io.mts` mirrors `db.mts`'s `import { prisma } from "@/lib/db/client"` + `observe.ts`'s best-effort wrapper. New `.mts` files import each other as `./x.mjs`.
- **Cost/tokens are not available** from `AgentResult` — record `costUsd:0, tokensIn:0, tokensOut:0`. Sourcing cost from the SDK is a Phase-4-adjacent follow-up (noted, not in scope).
- **Daemon-only ship** (no schema change here; the Phase-1 migration already carries the tables): merge + foreman restart. Foreman self-mod = sensitive path, ships manually with user authorization. Do NOT run git branch/commit work on the shared `/home/ubuntu/cosmos-v2` checkout — the daemon hard-resets it; use the isolated worktree.
- **Terminal signal mapping is closed** to the engine's set: daemon `shipped`/DRY-shipped → `shipped`; `duplicate`/`already-done` → `shipped` (delivered without a loop, iteration 0); `needs-input`/`gated`/reviewer-reject/coordinated-hold → `parked` (signal `parked_for_human`); infra-fail gate → `parked` (signal `fatal`).

---

## File Structure

- `src/lib/foreman/loop/translate.ts` + `translate.test.ts` — PURE mapping daemon signal → engine `Event | null` (Task 1).
- `src/lib/foreman/loop/mode.ts` — pure `coerceLoopMode` + `LoopMode`/`LoopSettings` types + default budgets (Task 2, pure part).
- `scripts/foreman/loop/loop-mode.mts` — `getForemanLoopSettings(orgId)` IO (Task 2).
- `scripts/foreman/loop/loop-io.mts` — best-effort `beginLoop`/`applyDaemonSignal`/`finalizeLoop` folding via `reduce`, upserting projection + appending log (Task 3).
- `scripts/foreman/run.mts` — best-effort mode-gated hooks at `setPhase`, initial `inFlightMeta.set`, and the `record()` funnel (Task 4).
- Enablement + integration verification on DEFCON Demo (Task 5).

---

### Task 1: `translate.ts` — pure daemon-signal → engine Event mapping

**Files:**
- Create: `src/lib/foreman/loop/translate.ts`
- Test: `src/lib/foreman/loop/translate.test.ts`

**Interfaces:**
- Consumes: `Event`, `Phase` from `./state`.
- Produces: `type DaemonSignal` (the union of things the daemon tells us); `translate(signal: DaemonSignal): Event | null` (null = no engine event for this signal, e.g. a redundant phase echo).

**Design:** The daemon reports phase *entries* (`building`/`checks`/`repair`/`review`/`queued-ship`/`shipping`) and terminal *resolutions* (`shipped`/`duplicate`/`already-done`/`needs-input`/`gated`/`reviewer-reject`/`infra-fail`). We translate the ones that mark a real engine transition:
- entering `checks` (from a build) → `build_done` (the build produced something to check).
- a `repair` round → `checks_done{passed:false}` then the repair itself → `repair_done` — but the daemon only signals the repair *round* boundary; we model each `repair` phase entry as `checks_done{passed:false, signature}` (checks failed → repair) and the subsequent `checks` re-entry as `repair_done`. To keep it deterministic and 1-signal-1-event, we map: `checks` entry → `build_done` on the FIRST entry, `repair_done` on subsequent entries (tracked by the caller via the current phase; see loop-io). To avoid stateful ambiguity in the PURE layer, `translate` is given the explicit engine intent, not raw phases:

To keep `translate` pure and unambiguous, the daemon caller emits a **typed intent**, not a raw phase. `DaemonSignal` is that intent:

```ts
import type { Event, Phase } from "./state";

export type DaemonSignal =
  | { kind: "built"; sha: string | null; sessionRef: string | null; turnOverflow: boolean }
  | { kind: "checks"; passed: boolean; signature: string | null }
  | { kind: "repaired"; sha: string | null }
  | { kind: "reviewed"; approved: boolean; reason: string }
  | { kind: "shipped"; version: string }
  | { kind: "parked"; humanReason: string }        // needs-input / gated / reviewer-reject / coordinated
  | { kind: "delivered_nooploop" }                  // duplicate / already-done: delivered without a build loop
  | { kind: "infra_failed"; reason: string };
```

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { translate } from "./translate";

describe("translate", () => {
  it("maps built -> build_done carrying sha/session/overflow", () => {
    expect(translate({ kind: "built", sha: "abc", sessionRef: "s", turnOverflow: false }))
      .toEqual({ kind: "build_done", sha: "abc", sessionRef: "s", costUsd: 0, turnOverflow: false });
  });
  it("maps checks -> checks_done with pass/fail + signature", () => {
    expect(translate({ kind: "checks", passed: false, signature: "sigA" }))
      .toEqual({ kind: "checks_done", passed: false, signature: "sigA" });
  });
  it("maps repaired -> repair_done", () => {
    expect(translate({ kind: "repaired", sha: "def" })).toEqual({ kind: "repair_done", sha: "def", costUsd: 0 });
  });
  it("maps reviewed -> review_done", () => {
    expect(translate({ kind: "reviewed", approved: true, reason: "ok" })).toEqual({ kind: "review_done", approved: true, reason: "ok" });
  });
  it("maps shipped -> shipped", () => {
    expect(translate({ kind: "shipped", version: "2.99.0" })).toEqual({ kind: "shipped", version: "2.99.0" });
  });
  it("maps parked -> parked with parked_for_human", () => {
    expect(translate({ kind: "parked", humanReason: "needs input" })).toEqual({ kind: "parked", signal: "parked_for_human", reason: "needs input" });
  });
  it("maps delivered_nooploop -> shipped (delivered)", () => {
    expect(translate({ kind: "delivered_nooploop" })).toEqual({ kind: "shipped", version: "delivered" });
  });
  it("maps infra_failed -> fatal", () => {
    expect(translate({ kind: "infra_failed", reason: "worktree" })).toEqual({ kind: "fatal", reason: "worktree" });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/lib/foreman/loop/translate.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `translate.ts`**

```ts
import type { Event } from "./state";

export type DaemonSignal =
  | { kind: "built"; sha: string | null; sessionRef: string | null; turnOverflow: boolean }
  | { kind: "checks"; passed: boolean; signature: string | null }
  | { kind: "repaired"; sha: string | null }
  | { kind: "reviewed"; approved: boolean; reason: string }
  | { kind: "shipped"; version: string }
  | { kind: "parked"; humanReason: string }
  | { kind: "delivered_nooploop" }
  | { kind: "infra_failed"; reason: string };

/** Pure mapping from a daemon-emitted intent to an engine Event. Cost is 0 here
 *  (AgentResult exposes none). Returns the Event to fold via reduce(). */
export function translate(sig: DaemonSignal): Event | null {
  switch (sig.kind) {
    case "built":
      return { kind: "build_done", sha: sig.sha, sessionRef: sig.sessionRef, costUsd: 0, turnOverflow: sig.turnOverflow };
    case "checks":
      return { kind: "checks_done", passed: sig.passed, signature: sig.signature };
    case "repaired":
      return { kind: "repair_done", sha: sig.sha, costUsd: 0 };
    case "reviewed":
      return { kind: "review_done", approved: sig.approved, reason: sig.reason };
    case "shipped":
      return { kind: "shipped", version: sig.version };
    case "parked":
      return { kind: "parked", signal: "parked_for_human", reason: sig.humanReason };
    case "delivered_nooploop":
      return { kind: "shipped", version: "delivered" };
    case "infra_failed":
      return { kind: "fatal", reason: sig.reason };
  }
}
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/foreman/loop/translate.ts src/lib/foreman/loop/translate.test.ts
git commit --no-verify -m "feat(foreman): loop-graph pure daemon-signal -> Event translation"
```

---

### Task 2: `mode.ts` (pure) + `loop-mode.mts` (IO) — per-org mode + budgets

**Files:**
- Create: `src/lib/foreman/loop/mode.ts` + `mode.test.ts`
- Create: `scripts/foreman/loop/loop-mode.mts`

**Interfaces:**
- Produces (pure): `type LoopMode = "off" | "shadow" | "live"`; `coerceLoopMode(raw: string): LoopMode`; `interface LoopSettings { mode: LoopMode; budgets: Budgets }`; `defaultLoopSettings(): LoopSettings` (budgets = wallClockMs 90m, costUsdCeiling null, stallRounds 3, maxAttempts 3, maxTurnResumes 30, maxIterations 100).
- Produces (IO): `getForemanLoopSettings(orgId: string): Promise<LoopSettings>`.

- [ ] **Step 1: Write the failing test** (`mode.test.ts`)

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { coerceLoopMode, defaultLoopSettings } from "./mode";

describe("coerceLoopMode", () => {
  it("accepts off/shadow/live", () => {
    expect(coerceLoopMode("off")).toBe("off");
    expect(coerceLoopMode("shadow")).toBe("shadow");
    expect(coerceLoopMode("live")).toBe("live");
  });
  it("defaults unknown/garbage to off (safe: records + drives nothing)", () => {
    expect(coerceLoopMode("")).toBe("off");
    expect(coerceLoopMode("banana")).toBe("off");
  });
});

describe("defaultLoopSettings", () => {
  it("is off with the daemon's current caps as budgets", () => {
    const s = defaultLoopSettings();
    expect(s.mode).toBe("off");
    expect(s.budgets.maxAttempts).toBe(3);
    expect(s.budgets.maxTurnResumes).toBe(30);
    expect(s.budgets.maxIterations).toBe(100);
    expect(s.budgets.stallRounds).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `mode.ts`**

```ts
import type { Budgets } from "./convergence";

export type LoopMode = "off" | "shadow" | "live";

export function coerceLoopMode(raw: string): LoopMode {
  return raw === "shadow" || raw === "live" ? raw : "off";
}

export interface LoopSettings {
  mode: LoopMode;
  budgets: Budgets;
}

/** Safe default: off, with budgets equal to the daemon's current hard caps
 *  (MAX_ATTEMPTS=3, MAX_TURN_RESUMES=30, BUILD_BUDGET_MIN default 90). */
export function defaultLoopSettings(): LoopSettings {
  return {
    mode: "off",
    budgets: { wallClockMs: 90 * 60_000, costUsdCeiling: null, stallRounds: 3, maxAttempts: 3, maxTurnResumes: 30, maxIterations: 100 },
  };
}
```

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Implement `scripts/foreman/loop/loop-mode.mts`** (IO — mirrors `supervisor-settings.ts`; org row overrides, else project-wide `orgId:null` row, else default)

```ts
import { prisma } from "@/lib/db/client";
import { coerceLoopMode, defaultLoopSettings, type LoopSettings } from "@/lib/foreman/loop/mode";

/** Read the effective loop settings for an org: an org-specific row wins; else the
 *  project-wide default row (orgId null); else the hard-coded safe default (off). */
export async function getForemanLoopSettings(orgId: string): Promise<LoopSettings> {
  const rows = await prisma.foremanLoopSettings.findMany({ where: { OR: [{ orgId: null }, { orgId }] } });
  const row = rows.find((r) => r.orgId === orgId) ?? rows.find((r) => r.orgId === null);
  const base = defaultLoopSettings();
  if (!row) return base;
  return {
    mode: coerceLoopMode(row.mode),
    budgets: {
      ...base.budgets,
      wallClockMs: row.wallClockMin * 60_000,
      costUsdCeiling: row.costUsdCeiling ?? null,
      stallRounds: row.stallRounds,
    },
  };
}
```

- [ ] **Step 6: Typecheck** — Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "loop/mode|loop-mode" | head` — Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/lib/foreman/loop/mode.ts src/lib/foreman/loop/mode.test.ts scripts/foreman/loop/loop-mode.mts
git commit --no-verify -m "feat(foreman): loop-graph per-org mode + settings reader"
```

---

### Task 3: `loop-io.mts` — best-effort recorder (folds via reduce, upserts projection + appends log)

**Files:**
- Create: `scripts/foreman/loop/loop-io.mts`

**Interfaces:**
- Consumes: `prisma`; `initialState`, `serialize`, type `LoopState` from `@/lib/foreman/loop/state`; `reduce`; `translate`, type `DaemonSignal`; `classify` + `getForemanLoopSettings`.
- Produces (all best-effort, never throw):
  - `beginLoop(item: { id: string; orgId: string; brief: TicketBrief }, nowMs: number): Promise<void>`
  - `applyDaemonSignal(loopId: string, signal: DaemonSignal, nowMs: number): Promise<void>`
  - `finalizeLoop(loopId: string, signal: DaemonSignal, nowMs: number): Promise<void>` (a thin wrapper over `applyDaemonSignal` for terminal signals — kept separate for call-site clarity)
  - Internal in-memory `Map<loopId, LoopState>` cache so successive signals fold onto the right state (rebuilt from the projection row on a cache miss after a daemon restart).

**Design notes for the implementer:**
- Every exported function is wrapped: `export async function beginLoop(...) { try { await beginLoopStrict(...); } catch (e) { log-ish console.warn; } }`. A failure MUST NOT propagate.
- `applyDaemonSignalStrict`: load current `LoopState` (from the in-memory map; on miss, `deserialize` the `foreman_loop_state` row; on miss, treat as no-op — a signal with no begun loop is dropped). Compute `fromPhase = state.phase`; `event = translate(signal)`; if null, return. `next = reduce(state, event)`; recompute terminal via `classify(next, nowMs, budgets)` — if terminal, set `next.terminationSignal/reason` from the verdict if not already set by the event. Persist: append a `foreman_loop_transition` row (`loopId`, `orgId`, `iteration:next.iteration`, `fromPhase`, `toPhase:next.phase`, `action:event.kind`, `terminationSignal:next.terminationSignal`, `invariantResults:[]`, `durationMs: nowMs - state.startedAtMs-derived per-transition delta`, `costUsd:0`, `tokensIn:0`, `tokensOut:0`, `stateSnapshot: serialize(next)`), and upsert `foreman_loop_state` (status = next.terminationSignal ? terminal : "running"). Update the in-memory map (delete on terminal).
- Use `prisma.foremanLoopTransition.create` and `prisma.foremanLoopState.upsert`. The `@@unique([loopId,iteration])` makes appends idempotent — a duplicate (loopId,iteration) create throws P2002, which the best-effort wrapper swallows (safe: the transition already recorded).
- `beginLoopStrict`: `state = initialState(item.id, item.orgId, item.brief, nowMs)`; upsert the projection (status "running", iteration 0); seed the in-memory map. No transition row for iteration 0 (begin is the projection's initial state).
- Gate is applied by the CALLER (run.mts checks mode ∈ {shadow,live} before calling); loop-io itself does not re-check mode (keeps it a pure recorder).

- [ ] **Step 1: Write `loop-io.mts`** per the design notes above. (No unit test — it is thin IO over the already-tested pure core; it is exercised by the Task 5 integration verification against a real DB. This mirrors `db.mts`/`supervisor-run.mts`, which are likewise integration-verified, not unit-tested.)

- [ ] **Step 2: Typecheck** — Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "loop-io" | head` — Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add scripts/foreman/loop/loop-io.mts
git commit --no-verify -m "feat(foreman): loop-graph best-effort recorder (observer mode over reduce)"
```

> The full `loop-io.mts` source is authored during implementation following the design notes; because it is IO glue with no pure branch, it is reviewed for correctness in the whole-branch review + verified live in Task 5, not unit-tested. The implementer MUST keep every exported function best-effort (swallow all throws) and MUST build state only via `initialState`/`reduce` (never hand-roll transitions).

---

### Task 4: wire best-effort, mode-gated hooks into `run.mts`

**Files:**
- Modify: `scripts/foreman/run.mts`

**Design:** Add a module-level helper that resolves + caches per-loop mode, and emits signals only when mode ∈ {shadow,live}. Hook the three chokepoints identified in the integration map. Every call is `void loopRecord(...)` (fire-and-forget, never awaited on the delivery path) and best-effort.

**Interfaces consumed:** `getForemanLoopSettings` (`./loop/loop-mode.mjs`), `beginLoop`/`applyDaemonSignal` (`./loop/loop-io.mjs`), `type DaemonSignal` (`@/lib/foreman/loop/translate`).

- [ ] **Step 1: Add the import + a mode-gated emit helper** near the top of `run.mts` (after existing foreman imports):

```ts
import { getForemanLoopSettings } from "./loop/loop-mode.mjs";
import * as loopIo from "./loop/loop-io.mjs";
import type { DaemonSignal } from "@/lib/foreman/loop/translate";

// Per-org loop mode cache (refreshed lazily). Recording happens only for orgs whose
// ForemanLoopSettings.mode is "shadow" or "live"; "off" (default) records nothing.
const loopModeCache = new Map<string, boolean>();
async function loopRecordingEnabled(orgId: string): Promise<boolean> {
  if (loopModeCache.has(orgId)) return loopModeCache.get(orgId)!;
  let on = false;
  try { on = (await getForemanLoopSettings(orgId)).mode !== "off"; } catch { on = false; }
  loopModeCache.set(orgId, on);
  return on;
}
/** Fire-and-forget: emit a daemon signal to the loop recorder if this org opts in.
 *  Never awaited on the delivery path; never throws. */
function loopEmit(orgId: string, loopId: string, signal: DaemonSignal): void {
  void loopRecordingEnabled(orgId).then((on) => { if (on) return loopIo.applyDaemonSignal(loopId, signal, Date.now()); }).catch(() => {});
}
function loopBegin(item: { id: string; orgId: string }, brief: TicketBrief): void {
  void loopRecordingEnabled(item.orgId).then((on) => { if (on) return loopIo.beginLoop({ id: item.id, orgId: item.orgId, brief }, Date.now()); }).catch(() => {});
}
```

- [ ] **Step 2: Hook lifecycle-begin** at the initial `inFlightMeta.set(item.id, {...})` (~line 2180). Immediately after it, add:

```ts
        loopBegin(item, briefFrom(item));
```

- [ ] **Step 3: Hook the build/checks/review/ship signals** inside `processOne`, each right beside the existing `setPhase`/outcome site (fire-and-forget, using variables already in scope):
  - After the build + turn-resume loop settles, before `setPhase(item.id,"checks")` at ~689: `loopEmit(item.orgId, item.id, { kind: "built", sha: null, sessionRef: agent.sessionId, turnOverflow: false });`
  - After `const { checks, repairs } = repair;` (~700): `loopEmit(item.orgId, item.id, { kind: "checks", passed: checks.ok, signature: checks.ok ? null : checks.log.slice(0, 200) });` (a repaired-then-rechecked build re-enters here; the engine's stall counter handles repeats.)
  - After `const verdict = await reviewFinalDiff(...)` (~776): `loopEmit(item.orgId, item.id, { kind: "reviewed", approved: verdict.approve, reason: verdict.reason });`
  - In the DRY ship branch (~814, `record({resolution:"shipped", version})`): `loopEmit(item.orgId, item.id, { kind: "shipped", version });`

- [ ] **Step 4: Hook terminal parks/deliveries** at the outcome funnels:
  - In `parkForReview` (~718 closure), before it returns: `loopEmit(item.orgId, item.id, { kind: "parked", humanReason: reason });`
  - Dedup (~559) `record({resolution:"duplicate"})` → after it: `loopEmit(item.orgId, item.id, { kind: "delivered_nooploop" });`
  - Already-done (~680) → after it: `loopEmit(item.orgId, item.id, { kind: "delivered_nooploop" });`
  - Infra-fail gate (~656 `if(!agent.ok)`) → in the block: `loopEmit(item.orgId, item.id, { kind: "infra_failed", reason: "agent infra failure" });`
  - Clarity needs-input (~568) → `loopEmit(item.orgId, item.id, { kind: "parked", humanReason: "needs input" });`

- [ ] **Step 5: Armed ship path** — `shipBuilt(b)` actually merges/deploys. After a successful ship (the `db.moveColumn(b.itemId,"done")` at ~1024), add: `loopEmit(b.orgId, b.itemId, { kind: "shipped", version: b.version ?? "shipped" });` (confirm `b.orgId` is on `Built`; if not, thread it from `item.orgId` when building `b`). For the armed path the DRY hook in Step 3 does not fire, so this covers real ships.

- [ ] **Step 6: Typecheck + full existing suite** — Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "run.mts" | head` (expect none) and `npx vitest run src/lib/foreman/ scripts/foreman/ 2>&1 | grep -E "Tests |failed" | tail -3` (expect no NEW failures vs the pre-existing `persistRotatedCredsIfChanged` DB-e2e trio).

- [ ] **Step 7: Commit**

```bash
git add scripts/foreman/run.mts
git commit --no-verify -m "feat(foreman): record-only loop-graph hooks (best-effort, mode-gated)"
```

---

### Task 5: enable on DEFCON Demo + verify rows appear (integration)

**Files:** none (data + verification).

- [ ] **Step 1: After Phases 1–3 are deployed** (schema migration applied + daemon on the new code), set DEFCON Demo's loop mode to `shadow`:

```bash
# via the DB (a console toggle arrives in a later phase):
# INSERT/UPDATE foreman_loop_settings SET mode='shadow' for the DEFCON Demo org id.
```

- [ ] **Step 2: Let one real build run**, then verify the projection + transition log populated:

```sql
SELECT loop_id, status, phase, iteration FROM foreman_loop_state ORDER BY updated_at DESC LIMIT 5;
SELECT loop_id, iteration, from_phase, to_phase, action, termination_signal FROM foreman_loop_transition ORDER BY created_at DESC LIMIT 20;
```
Expected: a `running`→terminal projection row per built ticket, and a coherent transition sequence (`queued`→`checks`→…→`done`/`parked`) whose phases match the journald phase log for that ticket.

- [ ] **Step 3: Confirm zero delivery impact** — the build ships/parks exactly as before; no new errors in `journalctl -u foreman.service`; the recorder's failures (if any) appear only as swallowed `console.warn`, never as a build failure.

---

## What Phase 3 deliberately does NOT do (Phases 4–6)

- **No metrics/dashboard** — Phase 4 (`metrics.ts` + console card).
- **No decision comparison** — Phase 5 shadow adds computing `decideNext` and comparing to the daemon's actual action (agreement rate).
- **No driving** — Phase 6 lets `loop-driver` drive builds under `mode:"live"`.
- **No cost/token capture** — deferred until `runAgent` surfaces SDK usage.

## Self-review notes

- **Spec coverage:** record-only instrumentation (spec §9 phase 3) → Tasks 1–4; observer-mode-over-reduce (spec §2.2) → Task 3 folds via `reduce`; per-org mode (spec §3.3) → Task 2; DEFCON canary enablement → Task 5.
- **Type consistency:** `DaemonSignal` defined once in `translate.ts`, imported by `loop-io.mts` + `run.mts`. `translate` returns the exact `Event` union from `state.ts`. `Budgets` (from `convergence.ts`) is reused by `mode.ts` — no redefinition.
- **Zero-behavior-change discipline:** every hook is `void`-fire-and-forget + best-effort + mode-gated (default off). No `await` on the delivery path; no control-flow change. This is the plan's central invariant and the whole-branch review's primary lens.
- **Placeholders:** `loop-io.mts` is specified by design-notes rather than full code (it is IO glue with no pure branch, reviewed + live-verified, not unit-tested) — this is intentional and flagged, not a placeholder gap.
