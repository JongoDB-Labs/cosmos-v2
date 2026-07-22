# Implementation Plan — Coordinated Multi-Phase Release Engine: same-file autonomy + three rough edges

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. All work in an ISOLATED git worktree (daemon hard-resets the shared checkout). Foreman self-mod is a SENSITIVE path — ships MANUALLY via `--admin` + deploy, never auto-shipped.

## Goal

Make Foreman's coordinated multi-phase release engine ship a coordinated epic **autonomously even when its phases edit the same file(s)** (e.g. `src/app/.../sprint-board.tsx`), and fix three adjacent rough edges that keep such a release stuck:

1. **Phase composition (core):** coordinated phases are each built independently off `main`, so at batch-merge time overlapping edits to the same file collide and the release aborts with *"code conflict merging phase … — coordinated release aborted (no half-release)"* — every time, even after rebuilding the stale phase.
2. **Phase-in-"done" can't be rebuilt:** a `@foreman rebuild` comment on a coordinated phase child that is NOT in the `review` column is misrouted to the read-only Q&A path ("question") and never rebuilds.
3. **Release doesn't re-fire on a non-approval event:** a coordinated release that becomes *ready — all phases green+approved* via something other than a fresh approval (e.g. a rebuild completing) never fires the batch merge, because the batch is only triggered from `handleCoordinatedApprove` on an approval event.
4. **Conflict attribution:** the abort message degrades to `(unknown)` when git reports the merge failure without a content-conflict file list, so a human can't tell which phase/file to fix.

**Non-negotiable safety invariant preserved throughout:** *no half-release* — a coordinated release must NEVER ship a partial or unverified subset of phases. Every change either keeps the release path mechanical or gates any non-mechanical step behind the SAME verification (`tsc --noEmit` tripwire → full checks → adversarial reviewer) that guards a normal ship, and aborts to human review on anything unresolvable.

## Architecture (today, with file:line refs)

**Layering.** Pure, vitest-tested cores live in `src/lib/foreman/*.ts` (no I/O); the daemon `scripts/foreman/run.mts` and the DB adapter `scripts/foreman/db.mts` do all I/O and call the cores. New *decision* logic goes in the pure cores; new *wiring* goes in the `.mts` files.

**Decomposition → phase children.**
- `src/lib/foreman/decompose.ts` — `planDecomposition()` splits an epic-sized FEATURE into one ordered `PhasePlan` per acceptance criterion; `dependsOnPhase = phase-1`; `coordinate = phases ≥ 2`.
- `scripts/foreman/run.mts:362` `decomposePass()` calls it and `db.decomposeEpic()`.
- `scripts/foreman/db.mts:543` `decomposeEpic()` creates one child per phase: phase 1 → `todo`, the rest → `backlog`; each child tagged `coordinated-phase-N` + `feedback:<class>`; the epic tagged `coordinated-release` + `decomposed` and moved to `review`. **Children are otherwise independent tickets.**

**Build.** `scripts/foreman/run.mts:611-620` — every ticket (phase child included) creates its branch with `git worktree add -B auto/<KEY> <wt> origin/main`. **This is the root cause of #1: every phase branches off `origin/main`, so two phases both editing `sprint-board.tsx` produce divergent copies that conflict when merged together.**

**Readiness gate (pure).** `src/lib/foreman/release-gate.ts`:
- `childReadiness(columnKey, tags)` → `done` OR `coordinated-ready` tag ⇒ `ready`; `coordinated-failed` ⇒ `failed`; else `pending`.
- `decideRelease({mode, siblings, policy})` → `hold` / `release` (with `batchMergeOrder`) / `abort`.
- `aggregateReadiness()` → console/summary label.
- `db.epicCoordination(itemId)` (`scripts/foreman/db.mts:464`) resolves the parent epic, maps each sibling to a `Sibling` (readiness + `dependsOn` from the phase tag) and each to a `CoordinationChild { itemId, key, branch: 'auto/<KEY>', readiness }`.

**Batch merge (the abort).** `scripts/foreman/run.mts:1208` `shipCoordinatedBatch(coord, batch)`:
- Creates integration worktree `auto/coordinated-<EPIC>` off `origin/main` (`:1217-1219`).
- For each phase branch in dependency order, `git merge --no-edit FETCH_HEAD` (`:1237`).
- On conflict, computes `conflicted = git diff --name-only --diff-filter=U`; if `!conflictsAreMechanical(conflicted)` → **abort** with `code conflict merging phase ${ref} (${conflicted.join(", ") || "unknown"})` (`:1242-1245`). The `|| "unknown"` branch is problem **#4**.
- Otherwise assigns ONE version (`nextVersion(mainVersion, coord.bumpKind)`), writes ONE combined changelog entry (`coordinatedChangelogEntry`, `:1193`), `tsc --noEmit` tripwire, push→PR→merge→tag→image→deploy, then `db.markChildrenShipped()`.
- `conflictsAreMechanical()` (`src/lib/foreman/ship-rebase.ts`) only allows the *version-race trio* `package.json` / `package-lock.json` / `src/lib/changelog.ts`. Any other conflicted path aborts. **A same-file code conflict on `sprint-board.tsx` is not in the trio ⇒ guaranteed abort.**

**Release trigger (only on approval).** `scripts/foreman/run.mts:1322` `handleCoordinatedApprove()` is the ONLY caller of `shipCoordinatedBatch`. It runs when a phase child gets an approve comment (`processMentions` → `handleApprove` → coordination interception at `:1396`). **There is no reconcile/idle path that notices "all phases ready but never shipped"** — confirmed: no `coordinatedEpics|coordinatedReleases|releaseAttempt|fingerprint` in `db.mts`/`run.mts`. `reconcileGated()` (`:1801`) only walks the solo-ship LEDGER (`pendingGated`), which coordinated releases never enter. This is problem **#3**.

**Comment routing.** `scripts/foreman/run.mts:1487-1560` `processMentions()`:
- `if (m.columnKey === "review")` → `combineIntents(texts)` → `approve` / `rebuild` (requeue to `backlog`) / `instruct` (resume).
- **`else` (any other column, incl. `done`)** → read-only Q&A agent reply + a hint "*Move the ticket back to Backlog…*". `combineIntents`/`classifyInstruction` (`src/lib/foreman/intent.ts`) are never consulted off the `review` column. **A `rebuild` on a `done` coordinated phase child falls through to Q&A.** This is problem **#2**.
- `FreshMention` (`scripts/foreman/db.mts:776`) carries `columnKey` but **not** `tags` or `parentRef` (query select `:850-873`/`:918-931` omits them), so the router can't tell a coordinated phase child from an ordinary ticket.

## Decision: how to fix the core (#1)

Three candidates evaluated:

**(a) Stacked phase builds — RECOMMENDED (primary).** Build phase *N* off phase *N-1*'s branch (dependency order) instead of off `main`. Each later phase's branch already contains all earlier phases' changes, so the batch "merge" degenerates to: take the **tip phase's branch** (already the whole stack), rebase it once onto current `main` (resolving only the mechanical version-race trio), and ship once.
- **Pros:** cross-phase conflicts vanish *by construction* — release path stays **purely mechanical** (no AI, no heuristic), the strongest safety story for a SENSITIVE self-modifying runtime. Deterministic. Directly delivers "ship even when phases touch the same file." Reuses the epic's `dependsOn` ordering.
- **Cons / mitigations:** (i) **serializes builds within one coordinated epic** — phase *N* can't start until *N-1*'s branch exists (acceptable: cross-epic parallelism unaffected; a shippable result beats intra-epic latency). (ii) **per-phase review base shifts** — base a stacked phase's diff on its parent branch (Task 5). (iii) **rebuild cascade** — rebuilding phase *K* invalidates *K+1…N*, which must re-stack (Task 6) — deterministic, and exactly the scenario #2/#3 support.

**(b) AI-assisted 3-way resolution at batch time — RECOMMENDED (bounded fallback only).** When a merge/rebase still conflicts on a real code file, invoke the build agent to resolve, then re-verify. Kept **only** as the fallback for the one residual case stacking can't remove — the *stack-vs-`main`* conflict (main advanced under the stack with an overlapping change). Fully gated: resolve in an isolated worktree → `tsc --noEmit` → full `npm run check` → adversarial reviewer over the resolved diff → only then ship; any gate failure or unresolved marker ⇒ **abort to human** (no half-release). Not the primary because injecting nondeterministic AI into the *happy path* of a sensitive self-mod release is a larger trust surface than we want by default.

**(c) Disjoint-file decomposition — REJECTED.** Scoping phases to non-overlapping files can't be guaranteed: per-AC phases of one feature naturally converge on the same UI/store files (exactly the sprint-board case). Not reliable enough to be the safety mechanism.

**Recommendation:** implement **(a) as the structural fix** so the happy path is mechanical + conflict-free, and keep **(b) as a gated fallback** for stack-vs-`main` only. Preserves "no half-release" with a mechanical happy path AND gives autonomy on same-file phases. (A lighter first increment — (b)-only against the existing independent-branch model — is viable but puts AI on the happy path; (a) is preferred for this sensitive daemon. Tasks 4–6 and the Task 7 fallback can land independently.)

## Tech Stack / Global Constraints

- TypeScript. Daemon = Node ESM `.mts` under `tsx`. Pure cores tested with **vitest**. Prisma/Postgres for state.
- **Self-modification is a SENSITIVE path.** Foreman must **never auto-ship its own runtime.** Changes to `scripts/foreman/*` and `src/lib/foreman/*` ship **manually** via a coordinated `--admin` merge + deploy — prepare commits on a branch/worktree, NOT auto-shipped by the daemon.
- **Daemon checkout race (gotcha):** `run.mts` hard-resets the shared `/home/ubuntu/cosmos-v2` checkout to `origin/main` every loop. **Do all work in an isolated worktree** (`/home/ubuntu/cosmos-v2-loopwork` or a fresh `git worktree`), or with the daemon stopped.
- **Release discipline:** run `npm run lint` + confirm `check` green BEFORE any `--admin` merge; `--admin` only bypasses the standing a11y-e2e + Trivy, never a new failure. A "What's-new"/changelog entry is required per release.
- **No half-release** invariant overrides any convenience.
- Prefer **migration-free** state (`WorkItem.tags`/`customFields` already the established coordinated-marker pattern) unless a real column is clearly cleaner; one optional migration in Task 8.

## File Structure

| File | Change | Why |
|---|---|---|
| `src/lib/foreman/release-gate.ts` | **add** `coordinatedReleaseFingerprint()`, `shouldRefireCoordinatedRelease()` (pure) | testable re-fire decision + attempt-dedup guard (#3) |
| `src/lib/foreman/release-gate.test.ts` | **add** tests | cover the two new pure functions |
| `src/lib/foreman/intent.ts` | **add** `honorPhaseCommand(columnKey, intent, isCoordinatedPhaseChild)` (pure) | when a phase child's approve/rebuild is honored off `review` (#2) |
| `src/lib/foreman/intent.test.ts` | **add** tests | cover `honorPhaseCommand` |
| `src/lib/foreman/ship-rebase.ts` | **add** `describeMergeFailure()` + `classifyConflict()` (pure) | conflict attribution (#4) + trio/cross-phase classification |
| `src/lib/foreman/ship-rebase.test.ts` | **add** tests | cover the two new pure helpers |
| `src/lib/foreman/decompose.ts` | **add** `stackedBase(phase, phaseRefs)` (pure) | "phase N stacks on phase N-1" base-branch rule, unit-testable |
| `src/lib/foreman/decompose.test.ts` | **add** tests | cover `stackedBase` |
| `scripts/foreman/db.mts` | **extend** `FreshMention` (+`tags`,`parentRef`) & query; **add** `isCoordinatedPhaseChild`, `reopenPhaseForRebuild`, `coordinatedReleasesReady`, `readReleaseAttempt`/`writeReleaseAttempt`, `cascadeRebuildLaterPhases`, `predecessorBranch`, `predecessorBuilt` | wiring for #1/#2/#3/#6 |
| `scripts/foreman/run.mts` | **rewrite** `shipCoordinatedBatch` (stacked + gated fallback + #4 message); **add** stacked build base in `processOne`; **add** phase-command routing in `processMentions` (#2); **add** `reconcileCoordinatedReleases()` in main loop (#3); **add** rebuild-cascade call | IO orchestration |
| `prisma/schema.prisma` + migration | **optional** `WorkItem.coordinatedBaseBranch` / release-attempt columns (Task 8) | only if reviewers prefer columns over customFields |

## Tasks

Ordering: Tasks 1–3 are self-contained pure-core + wiring fixes (#4, #2, #3), independently shippable, and de-risk Task 4–7. Do them first. Each task is TDD (failing test → red → implement → green → commit) in an isolated worktree.

### Task 1 — Precise conflict attribution (#4)
Add pure `classifyConflict(paths): "mechanical" | "cross-phase" | "opaque"` and `describeMergeFailure({phaseRef, conflictedPaths, gitStderr})` to `ship-rebase.ts` (+ tests): mechanical = exactly the version-race trio; cross-phase = any real code path conflicts; opaque = git failed with NO conflicted paths → surface raw stderr, never "unknown". Wire into `run.mts shipCoordinatedBatch`: capture merge stderr, replace the abort throw `:1242-1245` with `describeMergeFailure(...) — coordinated release aborted (no half-release)`. Extract the trio into a shared `VERSION_RACE_TRIO` const.
**Commit:** `fix(foreman): name the conflicting phase/files on coordinated-release abort (#4)`.

### Task 2 — Honor rebuild/approve on a phase child in any column (#2)
Add pure `honorPhaseCommand(columnKey, intent, isCoordinatedPhaseChild)` to `intent.ts` (+ tests): true only when NOT in `review`, IS a coordinated phase child, and intent is `approve`|`rebuild` (a bare `instruct` off `review` stays Q&A). Extend `FreshMention` with `tags`+`parentRef` (add to both `freshMentions` selects); add `db.isCoordinatedPhaseChild(m)`. In `run.mts processMentions` `else` branch, before Q&A: if phase child + honored → `rebuild` calls new `db.reopenPhaseForRebuild(itemId)` (move to `backlog`, `columnEnteredAt=now`, remove `coordinated-ready`/`coordinated-failed`/`already-done` tags) so the gate sees it `pending` again and HOLDS the release; `approve` calls existing `handleApprove`.
**Commit:** `fix(foreman): honor @foreman rebuild/approve on a coordinated phase child in any column (#2)`.

### Task 3 — Reconcile-pass re-fire of a ready-but-unshipped coordinated release (#3)
Add pure `coordinatedReleaseFingerprint(siblings)` (sorted key:readiness:tipSha) and `shouldRefireCoordinatedRelease({decision, currentFingerprint, lastAttemptFingerprint})` (fires only when gate=release AND fingerprint changed) to `release-gate.ts` (+ tests). Add `db.coordinatedReleasesReady()` (enumerate `coordinated-release` epics not fully shipped, with each sibling's branch tip SHA + epic's last-attempt fingerprint), `db.readReleaseAttempt`/`writeReleaseAttempt` (migration-free: `customFields.coordinatedReleaseAttempt = {fingerprint, at}`). Add `reconcileCoordinatedReleases(enqueueRepoWork)` after `reconcileGated()` in the main loop (`~:2086`), serialized behind the ship mutex: for each ready+changed epic, **write fingerprint BEFORE firing** (storm guard), then `enqueueRepoWork(() => shipCoordinatedBatch(...))`. A rebuild (Task 2) pushes a new tip → changed fingerprint → reconcile re-fires — this is how #2 and #3 compose.
**Commit:** `feat(foreman): reconcile-pass re-fire of ready coordinated releases with attempt-dedup (#3)`.

### Task 4 — Stacked batch merge (core of #1, ship side)
Add pure `stackedBase(phase, phaseBranches)` to `decompose.ts` (phase 1 → `origin/main`; N → phase N-1 branch; missing → main) + test. Rewrite `shipCoordinatedBatch` to a stacked fast path: fetch the TIP phase branch (last in order), integration worktree from it, rebase the whole stack onto current `origin/main` (mechanical trio resolve, mirroring solo `shipBuilt`/`autoRebaseParkedBranch` `:949-987`/`:1132-1181`), ONE version + ONE changelog, `tsc` tripwire, push→PR→merge→tag→image→deploy→`markChildrenShipped`. Before shipping, verify stack integrity: `git merge-base --is-ancestor` for each adjacent pair; if broken, fall to Task 7 (never silently ship a subset). Rebase-onto-main conflict: trio → mechanical; real code → Task 7 fallback; fallback fails → abort with `describeMergeFailure`.
**Commit:** `feat(foreman): stacked coordinated batch merge — ship the phase stack as one rebased version (#1)`.

### Task 5 — Build phase children stacked (core of #1, build side)
Add `db.predecessorBranch(itemId)` (via `epicCoordination` → predecessor's `auto/<KEY>` if it exists on origin, else null). In `run.mts processOne` (`:611-620`), base the worktree on `predecessorBranch ?? origin/main`. Sequential gate: only promote phase N once phase N-1's branch exists (`db.predecessorBuilt` in the promotion filter). Per-phase review base: in `reviewFinalDiff` (`:519`), diff against the phase's base (`origin/<predecessor>...HEAD`) not always `origin/main`, so the reviewer sees only THIS phase's delta.
**Commit:** `feat(foreman): build coordinated phase children stacked on their predecessor branch (#1)`.

### Task 6 — Rebuild cascade for stacked phases
Add `db.cascadeRebuildLaterPhases(itemId)`: after phase K (re)builds, requeue K+1…N (move to `backlog`, clear ready/failed markers). Call it from the Task 2 rebuild path and from an earlier phase's fresh-build completion. The sequential gate (Task 5) + cleared markers make the release-gate HOLD until the whole stack is green again — invariant preserved.
**Commit:** `feat(foreman): cascade-rebuild later phases when an earlier coordinated phase is rebuilt (#1)`.

### Task 7 — Bounded AI-assisted fallback for stack-vs-`main` conflicts
Only when Task 4's mechanical rebase hits a cross-phase/opaque conflict (or ancestry check fails). In the integration worktree, serialized behind the ship mutex: invoke the build agent with a NARROW prompt (resolve these conflicts preserving both intents; edit only conflicted files; don't touch version/changelog). Verify hard, abort on ANY failure: no markers (`git diff --check`) → commit → `tsc --noEmit` → `npm run check` → adversarial `reviewFinalDiff`. All-green → normal ship; any failure → reset, mark nothing done, throw with `describeMergeFailure` → epic held for a human. Document in code that this is the ONLY non-mechanical step and cannot ship anything the normal gates haven't approved.
**Commit:** `feat(foreman): gated AI-assisted resolution fallback for stack-vs-main coordinated conflicts (#1)`.

### Task 8 — (Optional) schema/migration for durable coordinated state
Migration-free by default (tags + `customFields`). If reviewers want first-class columns: `WorkItem.coordinatedBaseBranch String?` (audit + exact re-stack) and epic `coordinatedReleaseAttempt Json?`. Nullable/backward-compatible; flag the migration to the deploy step.
**Commit (if done):** `chore(db): columns for coordinated base branch + release-attempt fingerprint`.

### Task 9 — End-to-end verification (controlled, ships nothing)
Throwaway script under scratchpad / a `*.test.mts` fixture with a disposable git repo + test Postgres. Assert: (1) same-file 2-phase epic builds stacked → tip branch has both edits → `shipCoordinatedBatch` = ONE version + ONE changelog + all children done, no abort; (2) stack-vs-main drift → fallback resolves+re-verifies+ships; unresolvable → aborts, ships nothing, message names phase/files; (3) rebuild on a `done` phase re-opens to backlog (not Q&A); (4) all-ready via rebuild → `reconcileCoordinatedReleases` fires once, no re-fire on unchanged state, re-arms on tip change; (5) one phase `coordinated-failed` → hold-all aborts, nothing marked done. Run `npm run lint` + `npm run check` green.

## Rollout (manual, sensitive path)
Daemon must not auto-ship its own runtime. After Tasks 1–9 green in the isolated worktree: (1) `npm run lint` + confirm `check` green; (2) add the required What's-new/changelog entry; (3) coordinate a manual `--admin` merge + deploy per the standing Foreman procedure; watch the idle-gated self-restart onto new code; (4) verify live with a low-risk 2-phase same-file coordinated epic before trusting broadly.

## How the four fixes compose
- **#1** removes cross-phase conflicts *structurally* (stacking, Tasks 4–6) with a *gated* fallback (Task 7) for the only residual case — mechanical happy path.
- **#2** lets a human/daemon rebuild a stale phase from any column, pushing a new tip.
- **#3** notices the new tip via a changed fingerprint and re-fires the batch on the reconcile pass, no retry storm.
- **#4** makes every abort name the phase and files.
Every path aborts to human review and marks nothing `done` unless the single coordinated version merged AND deployed green — **no-half-release** holds end-to-end.

## Key file:line anchors
batch merge/abort `run.mts:1208-1310` (abort `:1242-1245`); build base `run.mts:611-620`; release trigger `run.mts:1322-1356`, interception `:1396`; mention routing `run.mts:1487-1560` (Q&A `else` `:1543`); main-loop reconcile insertion `run.mts:2086`; pure gate `src/lib/foreman/release-gate.ts`; trio `src/lib/foreman/ship-rebase.ts conflictsAreMechanical`; intent `src/lib/foreman/intent.ts`; `FreshMention`/`freshMentions` `db.mts:776-931`; `epicCoordination`/`decomposeEpic` `db.mts:464-604`.
