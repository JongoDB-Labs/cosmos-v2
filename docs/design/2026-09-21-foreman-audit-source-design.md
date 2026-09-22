# Foreman audit source — nightly self-originated cleanup

**Status:** design, not implemented. **Date:** 2026-09-21.
**Prompted by:** the "Nightly Audit Engineer" grokbot instructions, adapted to Foreman.

## The gap this fills

Foreman is demand-driven. It consumes work items humans create; it cannot
originate work. A nightly audit gives it a *source*.

## The one architectural decision

**An audit run emits work items. It does not run its own pipeline.**

The grokbot instructions start a cleanup agent per area directly. Foreman should
create a ticket per area and let the existing pass loop claim it, because that
inherits — for free, with no new plumbing:

- the check gate (tsc + eslint + vitest, recorded as `loop_check_evidence`)
- the risk/size gate
- `reviewFinalDiff`, the adversarial read-only reviewer, which is fail-closed
- the coordinated-release gate
- worker/slot limits, instead of an uncapped agent fleet
- `foreman_events` / `foreman_outcome` observability
- **visibility on the board**, so a human can kill an area before it ever runs

A parallel pipeline would have to re-earn every one of those. This is the whole
design in one line: *the audit is a ticket generator, not a second Foreman.*

## Shape

### 1. Trigger — a supervisor sub-pass

`runSupervisorPass` already runs periodically. Add an audit leg gated on a
watermark, with settings on `foreman_instance_config` (already read every pass,
already has a UI card):

| column | meaning |
|---|---|
| `audit_enabled` | off by default |
| `audit_at_hour` | local hour to run, e.g. `4` |
| `audit_last_run_at` | watermark |
| `audit_max_areas` | tickets one run may emit (**start at 2**) |

Run when `hour == audit_at_hour && audit_last_run_at < today`. No cron parser —
a cron string is a second configuration language for a job that runs once a day.

### 2. RESEARCH — read-only, complete, and *provably* complete

Fan out read-only agents over slices of the tree, split by area
(`src/app/(dashboard)`, `src/components/<domain>`, `src/lib/<domain>`, `prisma/`,
`e2e/`, `scripts/`, each plugin), capped by file count so a slice fits one
context.

Two things that are not in the source instructions and matter more than anything
else here:

- **Read-only is structural, not requested.** Research agents run with no
  worktree and a read-only tool set. An agent *asked* not to open a PR is not a
  guard.
- **Coverage is asserted, not claimed.** "Walk every file" is an instruction
  nobody checks. Each agent returns the file list it actually read; the
  aggregator diffs that against the slice manifest and logs the gap. An audit
  that silently skipped 40% of the tree and reported three findings looks
  identical to a clean tree.

### 3. The four lenses

1. **Platform best practices** — for this repo that is *`AGENTS.md` itself*:
   Cache Components rules, `useOrgQueryKey` on every client query key, base-ui's
   lack of `asChild`, permission masks crossing the DB via `maskFromDb`/
   `maskToDb`, `getPublicOrigin` for redirects. These are already written down,
   which makes this lens mechanically checkable and the highest-signal of the
   four.
2. **Dead / killable** — unused exports, orphaned components, unreachable
   routes, leftover flags whose branches are now identical.
3. **Needless complexity** — machinery with no user-visible difference.
4. **Comments** — **adapted; see below.**

### 4. The comment lens, changed on purpose

The source instructions say *"fewer comments, ONLY necessary ones."* Applied
here that would do damage. This codebase's rationale comments are load-bearing:
the COSMOS-158 fix reviewed on 2026-09-21 was worth merging largely because it
explained *why* `rows` is a no-op under `field-sizing: content` — the fix is
three lines, the reason it works is thirty.

So the lens is scoped to comments that are **false or purely narrating**:

- comments that contradict the code (stale after a refactor)
- comments that restate the line beneath them
- TODOs naming a closed ticket
- commented-out code

**Protected, never touched:** comments explaining *why*, comments citing a
ticket or incident, comments recording a rejected alternative.

One thing the source gets exactly right and is kept: **prefer deleting a stale
comment to rewriting it.** A rewritten comment is a fresh claim that nobody
verified.

### 5. AGGREGATE — deterministic code, not an agent

- dedupe by `(path, lens, normalized suggestion)`
- dedupe against **open PRs, open audit tickets, and findings rejected in
  previous runs**. The last one is not optional: without it the audit re-proposes
  every rejected cleanup nightly, forever. Dedupe against everything *seen*, not
  everything *accepted*.
- **group into areas, gate-aware**: pack an area to stay under the size gate
  (≤ 8 files, ≤ 400 lines). A single finding that blows the gate on its own is
  not an audit item — it is a ticket for a human.
- drop nitpicks, micro-optimisations, and anything in a protected path.

### 6. Bounds — the part that makes it safe to leave running

Not in the source instructions, and the reason this can be left on:

- **Cap areas per run.** Start at 2. An audit that emits fifteen tickets at 4am
  and merges them by 6am is not a cleanup, it is an unreviewed refactor of the
  whole tree.
- **Protected paths.** Never audit `prisma/migrations/`, `src/lib/rbac/`, auth,
  or anything on the sensitive-path risk list. Lowest cleanup value, highest
  blast radius.
- **No schema, dependency, or version-surface changes** from an audit ticket —
  stated in the ticket's acceptance criteria *and* enforced as a diff check at
  the ship gate. Acceptance criteria are not a control.
- **Audit tickets always `ask`, whatever the global decision mode.** Foreman
  auto-deciding a question about work it proposed, on code it chose to touch,
  with no human anywhere in the chain, is a closed loop with no external signal.
  This is the one place to hard-code `ask`.
- **Record empty runs.** "Stay quiet if nothing actionable" must not make a
  silent failure indistinguishable from a clean tree — the loop log already sat
  empty for a month and read as success.

### 7. Proof before it is trusted

1. Run with the emit step disabled: assert areas are produced, nothing claimed.
2. Assert coverage — files read vs. files in slice manifest.
3. Assert an empty run still writes a run record.
4. Assert a finding rejected in run N is absent from run N+1.
5. Only then enable emit, with `audit_max_areas = 1`, on a `dry` stage.

## Open questions for the owner

1. **Which tree?** Core only, or core + the Foreman/PI-planning plugins? Plugins
   are smaller and lower-risk — a good first target.
2. **Where do audit tickets land?** A dedicated `Cleanup` project keeps them off
   the delivery board; a label keeps them visible. Recommend a dedicated project.
3. **Ship stage for audit tickets.** They inherit `live` today, meaning a
   cleanup merges and deploys unattended. Recommend audit tickets are pinned to
   PR-only until a few have been watched end to end.
