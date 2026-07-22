# Unified Item Date Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Use superpowers:test-driven-development for each task (failing test first). Steps use checkbox (`- [ ]`) syntax. Create the isolated worktree in Task 0 first (the Foreman daemon hard-resets the shared checkout).

**Goal:** Replace the three broken "baseline" mechanisms with one date model (Planned Start, Projected End, Actual Start, Actual End) so the Gantt, boards, and PM trackers show schedule health inherently from a single pure rule, with no manual "Set baseline" step.

**Architecture:** A single pure module `src/lib/schedule/health.ts` (`healthOf` / `slipDays`) is the ONE coloring/variance rule, unit-tested and reused by the Gantt, the milestone Schedule tracker, the PM dashboard, and the deliverable tracker. Existing date columns are reused under unified names (only `WorkItem.actualStart` is new); the manual-baseline columns are dropped after code cutover. Every date-editing surface keeps persisting through its existing route (`PUT /work-items/{id}`, `/schedule`, `/schedule/{id}`) — only the field set and labels change; auto-capture of `actualStart` is added to the work-item PUT/POST alongside the existing `completedAt` done-column capture.

**Tech Stack:** Next.js App Router (route handlers), Prisma + PostgreSQL, Zod, React + TanStack Query/Table, SVG Gantt, Vitest, ESLint.

## Global Constraints

- **Non-destructive migration.** No user-visible date is lost. `start_date`/`due_date`/`completed_at`/`actual_date`/`actual_submission` are preserved and surfaced under unified names. Only the manual-snapshot columns (`work_items.baseline_start/baseline_end`, `milestones.baseline_date`, dead `milestones.projected_date`) are dropped.
- **One coloring rule.** `healthOf()` in `src/lib/schedule/health.ts` is the single source of truth for green/red/neutral. Every surface imports it — no surface re-implements the comparison.
- **Current plan only.** Variance = Actual End vs **current** Projected End (no frozen baseline). `slipDays()` falls back to today-vs-Projected while open.
- **Isolated worktree.** Daemon hard-resets `/home/ubuntu/cosmos-v2` to origin/main on a loop. Do ALL work in the Task-0 worktree.
- **Commit with `git commit --no-verify`.**
- **Normal app change (NOT foreman self-mod).** Ships via version-bump PR → confirm `check` green → `--admin` merge → tag → `deploy-apponly`. Requires a package.json bump + `src/lib/changelog.ts` entry. Run `npm run lint` + confirm `check` green before `--admin` (it only bypasses the standing a11y-e2e + Trivy).
- **Two-phase schema change.** Add-column migration (Task 2) + code cutover (Tasks 3-8) ship BEFORE the drop-column migration (Task 9).

## File Structure

| File | Created/Modified | Responsibility |
|---|---|---|
| `src/lib/schedule/health.ts` + `.test.ts` | Create | The ONE pure rule: `healthOf` + `slipDays`. |
| `prisma/migrations/…_add_work_item_actual_start/migration.sql` | Create | Add `work_items.actual_start` + backfill. |
| `prisma/migrations/…_drop_retired_schedule_baselines/migration.sql` | Create | Drop the 4 retired columns (post-cutover). |
| `prisma/schema.prisma` | Modify | Add `WorkItem.actualStart` (T2); drop retired fields (T9). |
| `.../work-items/[itemId]/route.ts` + `.../route.ts` | Modify | Accept `actualStart`/`completedAt`; auto-capture; override wins. |
| `.../work-items/[itemId]/route.date-capture.test.ts` | Create | Auto-capture + override assertions. |
| `.../timeline/baseline/route.ts` | Delete | Retire Set-baseline route. |
| `src/types/models.ts` | Modify | +`actualStart` (T4); −`baselineStart/End` (T8). |
| `src/lib/ai/egress/projection.ts`, `src/lib/ai/executors/milestones.ts` | Modify | Drop `baselineDate`/`projectedDate`. |
| `.../schedule/route.ts` + `.../schedule/[milestoneId]/route.ts` | Modify | Drop `baselineDate` from schema/write/audit. |
| `src/components/pm-dashboard/schedule-tracker.tsx` | Modify | Drop baseline col/field; variance via `slipDays`; health via `healthOf`. |
| `src/components/pm-dashboard/pm-dashboard.tsx` + both pm-dashboard `page.tsx` | Modify | Variance via `slipDays`; map `actualDate` not `baselineDate`. |
| `src/components/boards/timeline/release-timeline-view.tsx` | Modify | Milestone-date fallback → `dueDate`. |
| `src/lib/pm/export.ts`, `template-export.ts`, `src/lib/import/entity-fields.ts`, `entity-import.ts`, `prisma/seed/demo-defense-pm.ts`, `src/lib/pm/schedule.test.ts` | Modify | Remove baseline/projected readers + fixtures. |
| `src/components/pm-dashboard/deliverable-tracker.tsx` | Modify | Relabel "Due (Projected)"; Early/Late via the rule. |
| `src/components/work-items/card-detail-sheet.tsx` | Modify | Planned (Start·End) + Actual (Start·End) groups. |
| `src/components/boards/timeline/timeline-view.tsx` | Modify | Remove Set-baseline button + ghost bar; add actual overlay + health coloring. |
| kanban/timeline test fixtures | Modify | Drop baseline fields, add `actualStart`. |
| `package.json` + `src/lib/changelog.ts` | Modify | Bump `2.222.3` → `2.223.0` + What's-new. |

---

**NOTE:** The full task-by-task detail (exact code, test bodies, commands, and the self-review coverage table) is captured in the drafting record for this plan; the canonical structure is the 10 tasks below. Each task is TDD (write failing test → run/observe fail → implement → run/observe pass → commit `--no-verify`) and ends with an independently testable deliverable.

- **Task 0 — Worktree setup:** `git worktree add -b feat/unified-item-date-model … origin/main`; copy `.env`; `npm ci`; sanity `npx vitest run` a known test. All later commands run from the worktree.
- **Task 1 — Pure `healthOf`/`slipDays` module + table-driven tests.** `healthOf({projectedEnd, actualEnd, now})`: neutral if no projectedEnd; done → green if actualEnd ≤ projectedEnd else red; open → red if now > projectedEnd else green. `slipDays` = round((actualEnd ?? now) − projectedEnd) days, null if no projectedEnd.
- **Task 2 — Migration 1 (additive):** add `WorkItem.actualStart @map("actual_start")`; best-effort backfill from `column_entered_at` for items past not-started columns. `prisma migrate deploy` + `generate`.
- **Task 3 — Work-item PUT/POST:** accept `actualStart`/`completedAt` (manual override wins); auto-capture `actualStart` on first started (non-backlog/todo) column, never overwrite; keep done-column `completedAt` capture but skip when manual `completedAt` given; delete the `timeline/baseline` route. New auto-capture test.
- **Task 4 — Types + AI refs:** add `WorkItem.actualStart: string|null`; drop `baselineDate`/`projectedDate` from the milestone AI select + egress allowlist.
- **Task 5 — Milestone API + variance fix + relabel:** drop `baselineDate` from create/update schema+write+audit; schedule-tracker + pm-dashboard variance via `slipDays(actual vs projected)` (fixes the actualDate-ignoring bug); add "Actual End" column colored by `healthOf`; relabel "Projected End"; remove baseline field/column; update both dashboard page mappings, release-timeline fallback, export/template-export/import/seed/fixture readers.
- **Task 6 — Deliverable tracker:** relabel "Baseline Due" → "Due (Projected)"; Early/Late number via `slipDays`, color via `healthOf`; `govAcceptance` untouched. (`baseline_due` column kept — it IS the due date.)
- **Task 7 — Card detail sheet:** add `actualStart`/`actualEnd` state + hydrate + revert cases; regroup into **Planned** (Start/End) + **Actual** (Start/End) DatePicker groups persisting via `patchField` → PUT.
- **Task 8 — Timeline/Gantt:** remove `setBaseline` callback, Set-baseline button, Baselines lens (rename `showBaseline`→`showActuals`, repurpose to an "Actuals" overlay lens); remove ghost-bar geometry; add actual overlay (`actualStart → completedAt|today`) + `healthOf`-based bar stroke + tooltip "Slipped Nd late / Nd ahead"; remove `baselineStart/End` from the WorkItem type + three test fixtures.
- **Task 9 — Migration 2 (drop):** grep-guard that no non-test code references the 4 columns; remove them from schema; drop-column migration; `migrate deploy` + `generate`; full `tsc --noEmit`.
- **Task 10 — Verify + ship:** `npm run lint`, `npm run test`, `npm run build` all green; manual checks (no Set-baseline button, Actuals overlay, red on slip, Planned/Actual groups, auto-filled actualStart, schedule/deliverable relabels, 404 on old baseline route); bump to `2.223.0`; changelog entry; PR → check green → `--admin` merge → tag `v2.223.0` → `deploy-apponly` (applies both migrations); remove worktree.

## Self-review (summary)

Every spec section maps to a task (health rule→T1; variance→T1/5/6/8; per-entity→T3/5/6/7; auto-capture→T3; migration→T2/9; editing surfaces→T5/6/7/8; retire baseline→T3/8/9; milestone variance bug→T5; backward-compat/AI→T2/4/5). Grep-driven blast-radius: the drop touches `pm-dashboard.tsx` (same variance bug), both dashboard `page.tsx`, `export.ts`, `template-export.ts`, `entity-fields.ts`, `entity-import.ts`, `demo-defense-pm.ts`, `schedule.test.ts`, and 3 kanban/timeline fixtures — all explicit Modify targets so Task 9's drop compiles; Task 9 opens with a grep guard. Ordering avoids removing a type field before its reader (WorkItem gets `actualStart` in T4; `baselineStart/End` removed in T8 with their sole reader). No placeholders; names consistent (`healthOf`/`slipDays`/`actualStart`/`completedAt`; milestone actual=`actualDate`, deliverable actual=`actualSubmission`, deliverable projected=`baselineDue` kept).
