# Milestones move from Branches to Program Increments

**Date:** 2026-08-12
**Status:** approved, implementing
**Branch:** `feat/milestone-intervals-drop-branches`

## What changes

Milestones gain an optional link to a Program Increment and lose four fields. The
`ProgramBranch` model — the line-of-effort taxonomy — is removed from the product entirely.

1. `Milestone.branchId` → replaced by `Milestone.intervalId`, restricted to intervals of
   kind `PROGRAM_INCREMENT`.
2. `Milestone.phase`, `Milestone.milestoneType`, `Milestone.relatedRef` — dropped.
3. `ProgramBranch` — dropped, along with `branchId` on `Risk`, `Blocker`, `ChangeRequest`
   and `Deliverable`, and the free-text `Deliverable.branchOwner`.

## Why

**The four milestone fields are dead.** In production every milestone has `phase`,
`milestone_type` and `related_ref` set to `NULL`. Nothing is lost by removing them.

**Branches were never finishable.** There is no CRUD UI and no API route matching
`*branch*` anywhere under `src/app/api`. The only write in the repo is a
`prisma.programBranch.upsert` in `prisma/seed/demo-defense-pm.ts`. A user cannot create,
rename, reorder or delete a branch from the product — the taxonomy only ever arrives by
seed. The branch-scoped RBAC it feeds is likewise unreachable: `OrgMemberWorkRole.scope` is
`Json?`, documented as "reserved for a later iteration", and no route writes it, so
`branchScopeWhere()` evaluates to `{}` for every user.

**An interval is the better home.** `ProgramBranch` is org-scoped; `Interval` is
project-scoped, matching `Milestone`. Grouping a milestone under the PI that contains it
states a real scheduling relationship, where a branch code only ever tagged it.

## Data loss, accepted

Dropping the table discards branch tagging on a handful of milestones and risks in the
single tenant that had any — one org, three seeded branch rows. No other entity carries a
branch value anywhere. This was an explicit decision: hard drop, with the pre-migration
`pg_dump` as the only record. No values are migrated into `notes` or anywhere else.

There is **no** automatic migration of `branchId` → `intervalId`. Nothing in the codebase
ever associated milestones with intervals, even implicitly by date range, so there is no
mapping to preserve. Every milestone starts with `intervalId = NULL` and is assigned by
hand.

## Data model

```prisma
model Milestone {
  // removed: branchId, programBranch, phase, milestoneType, relatedRef
  intervalId String?   @map("interval_id") @db.Uuid
  interval   Interval? @relation(fields: [intervalId], references: [id], onDelete: SetNull)

  @@index([intervalId])
}
```

`SetNull` follows the precedent `Interval.parent` and `Objective.intervalId` already set:
deleting a Program Increment orphans its milestones, never deletes them.

### The constraint the database cannot express

A foreign key cannot say *"this interval must belong to the milestone's project, and must be
a `PROGRAM_INCREMENT`"*. Postgres will happily accept a sprint from another project. This is
the same class of latent inconsistency as `deliverables.milestone_id`, which sat unguarded
and produced cross-project references.

It is therefore enforced in the API layer on both create and update: the handler loads the
candidate interval and rejects it unless `projectId` matches the milestone's project and
`intervalKind === PROGRAM_INCREMENT`. A unit test covers both rejection paths.

## Scope of edits

**Chokepoint.** `loadMilestonesWithDerived` in `src/lib/pm/schedule.ts` is the single place
the branch was selected, and it feeds `/schedule` GET, `/milestones` GET, `export.ts` and
`template-export.ts`. Changing it there changes all four.

**Second API.** `src/lib/ai/executors/milestones.ts` and `src/lib/ai/egress/projection.ts`
query the same table with their own field allowlists. A field removed from the route is not
removed there.

**Importer.** `phase` is the one field of the four the spreadsheet importer maps
(`entity-fields.ts`, synonyms `phase`/`stage`/`gate`). Removing it drops a mapping users may
have in existing sheets; unknown columns are ignored rather than erroring.

**Exports.** The `Branch`, `Type` and `Related Ref` columns leave the Schedule sheet. The
XLSX template's `headerMatch` entries go blank rather than breaking the workbook, matching
how `branch assigned` / `branch supporting` already behave.

**Deleted outright.** `src/lib/pm/branch-label.ts` (+ its test), `src/lib/pm/branch-options.arch.test.ts`
(its "not vacuous" assertion fails once no register offers a picker) and
`src/lib/rbac/branch-scope.ts`.

## Testing

- Unit: the two API rejection paths (wrong project, wrong interval kind), and
  `loadMilestonesWithDerived` returning the interval.
- Mutation-test each new test by breaking the source and confirming a *named* test fails.
- `npx tsc --noEmit` is the real gate — vitest does not typecheck, and the fixture literals
  in `schedule.test.ts` fail only there.
- The migration is validated by applying it from scratch to a throwaway database and
  asserting the columns and table are gone and existing rows survive.
- `e2e/` is unaffected: no spec visits the PM dashboard. That also means no safety net.

## Rollout risk

`DROP COLUMN` and `DROP TABLE` are irreversible, and deployment is pull-based — merging to
main publishes an image that Foreman deploys without further review. A full `pg_dump` is
taken before the migration reaches prod.

## Versioning

Shipping as a **minor** bump. `AGENTS.md` classes breaking DB schema changes as major; that
guidance was raised and the minor was chosen deliberately. The changelog entry states the
schema break and the branch data loss prominently instead.
