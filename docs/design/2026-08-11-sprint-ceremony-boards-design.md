# Sprint Ceremony Boards

**Date:** 2026-08-11
**Status:** Approved, in implementation
**Board types added:** `SPRINT_PLANNING`, `SPRINT_REVIEW`

## Problem

Teams run sprint planning and sprint review/retro out of a hand-built PowerPoint.
Someone retypes the sprint's numbers into slides before every ceremony, and the
deck goes stale the moment anyone moves a card. The reference deck
a team supplied (10 slides) shows what teams actually need:
sprint metrics, what shipped, what carried forward, Start/Stop/Continue columns,
action items with owners and due dates, and a preview of the next sprint.

Cosmos already holds nearly all of that data. It just never shows it.

## What already exists

`src/lib/intervals/` holds 860 lines of pure, tested logic that covers most of
the deck:

- `sprint-review.ts` — `computeSprintReview()` returns `totalItems`,
  `completedItems`, `incompleteItems`, `totalPoints`, `completedPoints`,
  `efficiency`, `burnRate`, `pacing`, and `pacingStatus`. The burndown math is
  written and tested.
- `sprint-planning.ts` — `teamCapacity()`, `effectiveCapacity()`,
  `committedTotal()`, `isOverCommitted()`, points-vs-hours units.
- `next-sprint.ts` — `computeNextSprintDefaults()` produces the next sprint's
  window and name.
- `Interval.parentId` models the SAFe PI hierarchy, so a sprint knows its
  Program Increment.
- `IntervalCapacity` (interval × user × capacity) already models workload.

`computeSprintReview` has exactly one call site: the complete-sprint dialog in
`intervals-workspace.tsx:224`. A user can reach these figures only by ending a
sprint. **This feature is mostly a presentation problem.**

## Design

### Board types

Two new `BoardType` values, `SPRINT_PLANNING` and `SPRINT_REVIEW`. Each renders
one page with tabs rather than separate routes, because a facilitator switches
sections constantly during a live ceremony and navigation loses scroll position.

Workload/Capacity and Burndown/Velocity are **tabs**, not board types. Capacity
belongs to Planning, burndown and velocity to Review. Promoting them to
top-level types would duplicate the queries and create four places to keep
consistent.

### Retro columns are `BoardColumn` rows

The deck uses Start/Stop/Continue; the existing whiteboard template uses Went
well/Didn't/Try next. The column set must be configurable, so it reuses
`BoardColumn` — which already carries `name`, `key`, `color`, `sortOrder`, and
`category`, and already has CRUD built for Kanban. Column colors drive the
per-column dots the deck shows. Notes attach by `columnKey`, exactly as
`WorkItem` does.

`Board.config` holds only ceremony settings: enabled sections, the
classification banner, and `showNoteAuthors`.

### The board-type registry

Adding a board type today means editing four hand-maintained lists that nothing
keeps in sync:

1. `prisma/schema.prisma:42` — the `BoardType` enum
2. `board-renderer.tsx:50` — the `switch`, whose `default:` renders Kanban for
   any unhandled type, silently
3. `project-settings-client.tsx:48` — `BOARD_TYPE_OPTIONS`, 13 entries
   duplicating the enum; omit one and the type exists in the database but
   cannot be created in the UI
4. `save-as-board-dialog.tsx:29` — `BOARD_TYPES`, a different, narrower subset

Neither array derives from the enum, so TypeScript cannot catch an omission.
A single `BOARD_TYPE_REGISTRY` typed `Record<BoardType, BoardTypeDef>` replaces
both arrays and removes the silent fallthrough. Adding a type without a label,
a description, and a view now fails the build.

### Data model

Four additions. Everything else derives.

```prisma
enum CeremonyKind   { PLANNING  REVIEW }
enum CeremonyStatus { DRAFT  RUNNING  CLOSED }

model SprintCeremony {          // one run of one board against one sprint
  boardId    String  @db.Uuid   // → Board,    Cascade
  intervalId String  @db.Uuid   // → Interval, Cascade
  kind       CeremonyKind
  status     CeremonyStatus @default(DRAFT)
  closedAt   DateTime?
  @@unique([boardId, intervalId])
}

model RetroNote {
  ceremonyId String  @db.Uuid   // Cascade
  columnKey  String             // → BoardColumn.key
  text       String
  authorId   String? @db.Uuid   // SetNull: losing a person keeps the retro
  @@index([ceremonyId, columnKey])
}

model RetroActionItem {
  ceremonyId String    @db.Uuid  // Cascade
  text       String
  ownerId    String?   @db.Uuid
  dueDate    DateTime?
  workItemId String?   @db.Uuid  // set when promoted
}
```

`SprintCeremony` earns its row three ways: it gives notes and actions a cascade
parent, it records that a ceremony ran and closed, and its `@@unique` lets one
board run every sprint without duplicating.

The model deliberately omits note voting (neither the deck nor the existing
whiteboard template has it) and any stored copy of the metrics.

### Derivation

One endpoint returns the whole ceremony in one request. Per-tab fetching would
issue N requests exactly when a facilitator stands in front of the team.

| Deck slide | Source |
| --- | --- |
| 1 — title, sprint, PI, parent epic | `interval` + `interval.parent` + epic |
| 2 — metrics | `computeSprintReview()`, a second call site |
| 3 — what shipped | `workItems.filter(isDoneColumnKey)`, by points |
| 4 — carrying forward | the inverse, grouped by `BoardColumn.category` |
| 5–7 — Start/Stop/Continue | `RetroNote` by `columnKey` |
| 8 — action items | `RetroActionItem` |
| 9 — next sprint preview | `computeNextSprintDefaults()` + carried set |
| Planning capacity | `IntervalCapacity` → `sprint-planning.ts` |

Storing no metrics means the board cannot drift from the work items. Reopen a
year-old retro and its numbers still reconcile.

The deck reports **95** in points but **76%** in items (19 of 25). `SprintReview`
exposes `basis` and both raw pairs, so the UI renders each in its own unit.

### Completion erases the carried set

`complete/route.ts:58-66` reassigns `intervalId` on every incomplete item when a
sprint completes. Once that runs, the finished sprint no longer owns those items
and slide 4 derives to empty. `sprint-review.ts` states the assumption in its
own docstring: the figures appear "when a sprint is being completed, BEFORE it
is finalized."

The fix persists the carried work-item **IDs** into the existing
`Interval.report` JSON at completion. Slide 4 reads live while the sprint is
`ACTIVE` and from `report` once `COMPLETED`. This stores historical fact — what
moved — rather than derivable state.

### Live behaviour

Realtime events carry references only: adding a note publishes
`{ ceremonyId, columnKey }` through `publishToOrg`, never the text. Postgres
`NOTIFY` caps at 6 KB, so ceremony content on the bus would truncate under
exactly the load a whole team typing creates. Clients refetch through their
org-scoped query key. The author sees an optimistic insert.

Notes display unattributed by default. `authorId` persists — a person must be
able to delete their own note — but the DTO omits it unless
`Board.config.showNoteAuthors` is set. A retro is honest only when people need
not sign their complaints.

Any project member adds notes and actions. Opening and closing a ceremony
requires the permission the complete-sprint route already enforces.

Promoting an action item creates a real `WorkItem` carrying the owner and due
date, targets the next sprint, and writes `workItemId` back. Re-promoting does
nothing rather than duplicating.

Present mode collapses the tabs into a full-bleed, keyboard-navigable view that
matches the deck's layout, including the classification banner. That is what
replaces the PowerPoint.

## Verification

- Mutation-test every new test: break the source, confirm a **named** test
  fails, restore. React tests bail out on identical re-renders, so a component
  test can pass against the bug it guards.
- `npx vitest run` carries ~82 pre-existing failures across ~31 files from
  having no seeded test database. Compare against that set.
- Finish with `npx tsc --noEmit`. Vitest does not typecheck.
- Apply the migration to a throwaway database from scratch, then assert the
  cascades and the `SetNull` it promises.
- Grep `e2e/` for every label touched. `tsc`, `eslint`, and `vitest` never load
  those specs, and `e2e` does not gate merges.
- Drive the deployed screen. Deployment is pull-based: CI publishes an image and
  the Foreman daemon deploys it.

## Out of scope

Note voting, deck export (Markdown/PDF), cross-team ceremonies, and live
cursors. PI-level ceremonies remain in the `pi-planning` plugin; this covers
sprint-level ceremonies, whose data lives in core.
