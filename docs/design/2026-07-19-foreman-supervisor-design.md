# Foreman Supervisor (self-grooming loop) — Design

**Status:** approved design, pre-implementation
**Author:** brainstormed 2026-07-19
**Scope:** a single subsystem — the Foreman *supervisor*. A sibling epic ("Foreman project- & subscription-aware harness: skills/plugins/MCP") is explicitly OUT of scope and gets its own spec.

## Goal

Give Foreman a **self-grooming loop** so the parked/outcome side of the board manages itself instead of needing a human to babysit it. Today the `planner` grooms *intake* (ranks backlog → promotes to `todo`); nothing grooms *outcomes* (parked `review` tickets). A human currently has to notice "this parked draft is already delivered," "this one failed on a since-fixed bug," "these two are duplicates," or "this needs a product decision." The supervisor encodes exactly those judgments and acts on them autonomously, with a full audit trail.

## Architecture

The supervisor is a **symmetric sibling of the planner**: the planner grooms intake, the supervisor grooms outcomes. It borrows the *durable-execution concept* (idempotent, event-sourced, replay-safe decisions) without adopting a framework — a deliberate "don't rip-and-replace" choice. An explicit durable state-graph (LangGraph/Temporal-style) that would also fix the resume-fragility bug class is a **later** evolution (Approach B), not this spec.

### Components

- **`src/lib/foreman/supervisor.ts`** — new **pure core** (mirrors `planner.ts`: no I/O, unit-tested in isolation because vitest can't load the `.mts` daemon modules). Given a parked ticket's facts, returns a typed **`GroomingVerdict`**. All decision logic lives here.
- **`supervisorPass()`** in `scripts/foreman/run.mts` — the **I/O + orchestration**: runs on idle ticks, gathers facts, calls the pure core per ticket, executes verdicts idempotently. Thin, delegates to the core (same shape as the planner's daemon glue).
- **Reused infrastructure** (no rebuilds):
  - `analyzeRequirements` / `recommendForApproval` GitHub+model plumbing (`src/lib/foreman/`) — delivered-detection + PR/diff reads.
  - `db.moveColumn`, the `claim`/demotion helpers (`scripts/foreman/db.mts`) — re-queue + race guards.
  - the `foreman_events` stream + realtime `pg_notify` emits — audit trail + live board/console.
  - the planner's `isStandingDemotion` pattern — human-action respect.

### `GroomingVerdict` (pure-core output)

```
type GroomingKind = "deliver-close" | "requeue" | "dedup-consolidate" | "escalate" | "leave";
interface GroomingVerdict {
  kind: GroomingKind;
  confidence: number;      // 0..1; below the per-behavior threshold ⇒ downgraded to "escalate"
  evidence: string;        // one concise line (shown in UI + event)
  dupOf?: string;          // ticket key, for dedup-consolidate
}
```

## The four behaviors

A **supervisor pass** fires on an **idle tick** (no builds in flight, `todo`/`backlog` queue drained, and a min-interval has elapsed since the last pass). It gathers: `review`-column tickets for the delivery orgs + their park events (reason) + draft-PR URLs; a compact index of *other* tickets (for dedup); and the current version/changelog. Then, per ticket (bounded concurrency), it skips anything a human touched since the relevant event or that already has a matching `groomed` event, and produces one verdict:

1. **`deliver-close`** — asks the question distinct from approval: *"is this ticket's intent already on `main`, independent of this draft?"* (delivered-elsewhere, not "is this PR good"). Reuses `analyzeRequirements` plus an on-main presence check. High confidence + grep-backed evidence ⇒ **close the draft PR** (comment with evidence) + `moveColumn(→done)` + set `completed_at`.
2. **`requeue`** — for tickets parked on a *failure* (checks-failed / infra error / reviewer-infra-failure), NOT on a scope/sensitive gate. Eligible when the park reason matches a curated **known-transient signature set** — `must_change_password`, `a pull request for branch … already exists`, `No conversation found with session ID`, `reviewer agent failed twice (infra)` — **or** the park predates a since-shipped fix (park `ts` < a relevant release date / `main` has advanced). Action: `moveColumn(review → backlog)` so the planner re-picks a **fresh** build against current `main`. **Guard:** re-queue a given ticket **at most once per `main` SHA**; if it re-fails the same way, `escalate` instead of looping. The build itself is ground truth — if it still fails, it re-parks and won't be re-queued again for the same reason.
3. **`dedup-consolidate`** — model similarity of a ticket's intent against **keyword/feedback-source-matched candidates only** (bounded, not O(n²)). If a ticket duplicates a delivered/original ticket ⇒ close its draft, comment linking to the canonical ticket, mark it done-as-duplicate. (The real C105/C135 case: both "feedback triage on Foreman's Claude.")
4. **`escalate`** — the catch-all: build-agent-flagged ambiguity (e.g. a `mention-reply` "Needs your input"), low supervisor confidence, or underspecified requirements ⇒ post a human-visible comment + realtime notify and **leave the ticket parked** (no mutation). Extends Foreman's existing clarity-judge/mention-reply behavior.

### Data flow of a pass

1. **Trigger** — idle tick + min-interval.
2. **Gather** — `review` tickets + park events + PR URLs; other-ticket index; version/changelog.
3. **Per ticket** — skip (human-touched / already-groomed) → delivered-detection → (if not) requeue-eligibility → dedup check → emit a `GroomingVerdict`.
4. **Execute idempotently** — write the `groomed` `foreman_event` **first** (records prior state + verdict + evidence), **then** mutate (close PR / `moveColumn` / comment), **then** emit realtime.
5. **Bound** — cap mutations per pass (≈5); overflow is logged and deferred to the next pass.

## Safety rails

- **Per-pass mutation cap** (≈5; overflow logged + deferred) — a bug or bad model output can't mass-mutate the board.
- **Confidence threshold** (per behavior) — act only above it; below ⇒ `escalate`, never a silent wrong action.
- **Everything reversible** — close (reopenable), `moveColumn` (movable back), done (movable back); **no hard deletes**. The `groomed` event records prior state ⇒ one-move undo.
- **Human-action respect** — never groom a ticket a human touched (edit/comment/move) since the relevant event; mirrors `isStandingDemotion`. A manual action always wins and suppresses re-grooming.
- **Idempotency / replay-safety** — before acting, check for an existing `groomed` event keyed `(ticketId, stateSHA, action)`; no-op if present. Safe across daemon restarts.
- **Kill-switch + per-org opt-in** — `mode = off | dry | live` (per-org, see UI). Disabling never touches the build loop.
- **Self-modification caution** — closing a *foreman-sensitive-path* ticket (`scripts/foreman/`, `src/lib/foreman/`) as delivered demands extra confidence or escalates. Re-queue still passes the existing risk-gate (sensitive changes park for a human anyway), so there is **no gate bypass**.

## Failure handling

- **Model / GitHub unavailable** ⇒ that ticket yields `leave` (do nothing), retried next pass. Fallback is **inaction**, never a default action (contrast: `approval-recommendation`'s UNAVAILABLE defaults to `rework` because a human is reading it; here nothing is watching, so do nothing).
- **Per-ticket isolation** — one ticket failing doesn't abort the pass; the error is logged as an event.
- **Re-queue loop protection** — once-per-`main`-SHA guard + escalate-on-repeat.
- **Wrong action recovery** — the event trail makes every action a one-move undo; a human moving it back also sets the human-respect flag so it isn't re-groomed.

## UI: configurability & observability (Foreman console)

Reuses existing console patterns (Claude + GitHub PAT settings cards, activity feed, phase badges, per-item AI-Analysis panels, realtime emits).

**Configurability** — a new **Supervisor settings card**, per-org, `ORG_MANAGE_SETTINGS`-gated, stored like `ForemanAiSettings` (so it's UI-controlled, not just env):
- **Mode**: `off` / `dry` / `live` (primary control).
- **Per-behavior toggles**: independently enable deliver-close / requeue / dedup / escalate.
- **Advanced (collapsed, sensible defaults)**: confidence threshold + per-pass cap.

**Observability**:
- **Grooming feed** — `groomed` events render live in the console (a section/filter of the activity feed): ticket, verdict, one-line evidence, timestamp; realtime via the existing emit.
- **Dry-run preview** — in `dry` mode the console lists the verdicts the supervisor *would* take, each with an **Apply** button — eyeball proposed grooming against the real board before flipping `live`. This is the rollout UX.
- **Per-ticket badge** — a parked card/detail shows its latest supervisor verdict ("would close as delivered", "re-queued 2h ago") + evidence.
- **One-click undo** — each grooming action offers undo (reopen PR / move back), which also sets the human-respect flag.
- **Weekly summary** — a small "supervisor did: N closed · M re-queued · K escalated" line.

**Data flow (UI):** config via a new per-org settings row + a console GET/PUT API route (`ORG_MANAGE_SETTINGS`); observability via the `groomed` events (+ dry-run computed verdicts) served through a console API route + the existing realtime channel.

## Testing & rollout

- **Pure-core unit tests** (`src/lib/foreman/supervisor.test.ts`, like `planner.test.ts`): each verdict path (delivered vs pending, requeue-eligible signatures, dedup similarity), the known-transient signature set, confidence gating/downgrade, the human-respect predicate, the per-pass cap, and the idempotency no-op.
- **Daemon glue** (`supervisorPass`) follows the existing thin-I/O pattern, tested via the same injectable seams used for `processOne`/planner.
- **`dry` mode** computes + logs verdicts **without mutating** — the key rollout safety. Run `dry` against the real backlog, review the verdicts (in-console preview), then flip `live`, per-org.

## Explicit non-goals (this spec)

- The explicit durable state-graph rewrite (Approach B) — later.
- The skills/plugins/MCP "project- & subscription-aware harness" epic — its own spec.
- Any change to the build agents themselves, the risk-gate, or the ship pipeline.
