# Design — Unified Item Date Model (planned/actual start & end + inherent schedule health)

**Status:** approved design, pre-plan. **Author:** Claude (session 016JxYxhuaCXEVknXAGJ4KKQ). **Date:** 2026-07-22.

## Goal

Replace three unrelated, partly-broken "baseline" mechanisms with **one date model** across every schedulable entity, so the Gantt and boards show schedule health *inherently* — no manual "Set baseline" step.

Four canonical date concepts:
- **Planned Start** — when it was supposed to start.
- **Projected End** — when it's supposed to be done/delivered (the target).
- **Actual Start** — when it actually started.
- **Actual End** — when it actually finished/was delivered.

**Schedule health = one rule, everywhere:** compare **Actual End vs Projected End**.
- **Green (on time / ahead):** finished on or before Projected End.
- **Red (slipped):** finished after Projected End; OR *today* is past Projected End and it isn't done yet.
- **Neutral:** not started / no dates.

Variance is measured against the **current** Projected End (no frozen baseline — user decision "current plan only"). Editing Projected End re-plans the target.

## Per-entity application

Only things that span time have a start; points-in-time have only an end.

| Entity | Planned Start | Projected End | Actual Start | Actual End |
|---|---|---|---|---|
| **Work item** (ranged) | ✅ | ✅ | ✅ | ✅ |
| **Milestone** (a moment) | — | ✅ (target date) | — | ✅ (hit date) |
| **Deliverable** (a due + a delivery) | — | ✅ (due) | — | ✅ (submission) |

Deliverable `govAcceptance` stays a **separate govcon compliance field** — it's a distinct downstream step, not the delivery date, and is out of the schedule-health rule.

## Data model & migration (non-destructive — reuse existing columns, expose under unified names)

We do **not** move data destructively. Existing columns already hold most of the concept; the API/UI expose them under the unified names. Only one new column is added; the retired columns are dropped after cutover.

| Unified field | WorkItem col | Milestone col | Deliverable col |
|---|---|---|---|
| plannedStart | `startDate` | — | — |
| projectedEnd | `dueDate` | `dueDate` | `baselineDue` (relabel to "due/projected") |
| actualStart | **new `actualStart`** | — | — |
| actualEnd | `completedAt` | `actualDate` | `actualSubmission` |

**Migration steps (Prisma):**
1. Add `WorkItem.actualStart DateTime? @map("actual_start")`.
2. Backfill `actualStart` for already-in-progress/done items where derivable (best-effort from `columnEnteredAt`/first in-progress transition if available; else leave null and let auto-capture fill it going forward).
3. **Retire** (drop, after code no longer references them): `WorkItem.baselineStart`, `WorkItem.baselineEnd`, `Milestone.baselineDate`, `Milestone.projectedDate` (dead column — never written today). Deliverable `baselineDue` is kept (it *is* the due date) but relabeled in API/UI as the projected end.
4. Data safety: dropping the WorkItem baseline columns discards manually-snapshotted baselines — acceptable per the "current plan only" decision (planned dates = `startDate`/`dueDate` remain intact). No milestone/deliverable *dates* are lost; only the unused `projectedDate` and the milestone `baselineDate` variance-reference are removed.

## Auto-capture (with manual override)

- **Actual Start** — auto-set the first time a work item enters an "in progress" column (reuse the column-classification already used for `completedAt`); never overwritten once set.
- **Actual End** — the existing done-column capture (`completedAt` today); cleared if the item leaves a done column. Milestones/deliverables set Actual End on their existing "completed/submitted" action.
- Both remain **editable** in the detail sheet for correction; a manual edit wins over the auto value (and is preserved thereafter).

## Editing surfaces (every board → the same fields)

All keep writing through the existing routes (`PUT /work-items/{id}`, `/schedule`, `/deliverables`), with the cleaned-up field set:
- **Card detail sheet:** two clear groups — **Planned** (Start · End) and **Actual** (Start · End). Actual fields show their auto-captured value, editable.
- **Gantt/Timeline drag:** edits the **planned** bar (`startDate`/`dueDate`).
- **Table / backlog / calendar:** inline-edit Projected End (`dueDate`), consistent with today.
- **Milestone Schedule tracker:** show Projected End + Actual End (+ health); **remove the confusing baseline column** and the dead "projected date" field; fix variance to use Actual-vs-Projected (see below).
- **Deliverable tracker:** Projected End (due) + Actual End (submission) + health; `govAcceptance` stays as its own compliance field.

## Gantt / Timeline visualization

Replace the ghost-baseline sub-bar + red slip-tail with:
- **Planned bar:** `plannedStart → projectedEnd`.
- **Actual overlay** (once started): `actualStart → (actualEnd or today)`.
- **Coloring by the one health rule:** green if on/ahead, red if slipped (Actual End after Projected End, or today past Projected End and not done).
- **Milestone diamonds** keyed off Projected End with an Actual marker; slip = actual/now vs projected.
- Retain critical-path highlighting (dependency-derived, unchanged).

## What is retired

- The **"Set baseline" button** (`timeline-view.tsx`) and its route (`.../timeline/baseline`).
- WorkItem `baselineStart` / `baselineEnd` columns + all readers.
- `Milestone.projectedDate` (dead) and `Milestone.baselineDate` (baseline concept removed).
- The milestone **variance bug**: today `variance = dueDate − baselineDate` and *ignores* `actualDate`. New: health/variance = **Actual End vs Projected End** (falls back to today-vs-Projected while open).

## Backward-compatibility / no-breakage checklist

- Existing `startDate`/`dueDate`/`completedAt`/`actualDate`/`actualSubmission` values are **preserved** and simply surfaced under the unified names — no user-visible date is lost.
- Every current date-editing surface keeps its route; only the field set/labels change.
- AI egress allowlists / executors that reference `projectedDate` (`lib/ai/egress/projection.ts`, `lib/ai/executors/milestones.ts`) are updated to the unified fields.
- `release-timeline-view.tsx` milestone-date fallback (`dueDate ?? baselineDate ?? projectedDate`) collapses to `dueDate` (projected end).

## Testing

- **Unit (pure):** the schedule-health function (`healthOf({projectedEnd, actualEnd, now})` → green/red/neutral) — the single source of truth for coloring, reused by Gantt, trackers, and any status pill. Table-driven tests over the boundary cases (on time, ahead, late-after-done, past-due-open, no-dates).
- **Auto-capture:** entering in-progress sets `actualStart` once; entering done sets Actual End; leaving done clears it; manual override persists.
- **API:** `PUT /work-items` accepts the new field set; migration backfill correctness; retired fields rejected/ignored.
- **Regression:** each editing surface still persists dates; Gantt renders planned + actual; milestone/deliverable trackers show health without the baseline column.

## Out of scope (noted, not built)

- Auto-frozen "original baseline" for honest variance-against-original (available later if wanted; never the manual button).
- Deliverable govcon acceptance workflow changes beyond keeping `govAcceptance` as-is.
- Cross-entity roll-ups / earned-value metrics.

## Implementation shape (for the plan)

- New pure module `src/lib/schedule/health.ts` (`healthOf`, `slipDays`) + tests — the one coloring rule.
- Prisma migration (add `actualStart`; drop retired columns in a follow-up migration after code cutover).
- Auto-capture in the work-item `PUT` route (extend the existing `completedAt` column-classification to also set `actualStart`).
- API/type updates: `src/types/models.ts`, the work-item/schedule/deliverable routes and their zod schemas → unified field set.
- UI: card-detail-sheet grouping; timeline-view (remove baseline button + ghost bar, add actual overlay + health coloring); schedule-tracker + deliverable-tracker relabel; table/backlog/calendar unchanged except labels.
