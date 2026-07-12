// Pure decision core for the approval loop's "approve" intent: given whether a
// parked ticket has an open PR and whether that PR is already merged, decide what
// the daemon should do. No IO — the daemon (scripts/foreman/run.mts) supplies the
// facts (parked.prUrl presence + a `gh pr view` state check) and executes the
// verb; keeping the branch logic here makes it unit-testable in isolation.

/** What an "approve" comment on a parked ticket should trigger:
 *  - "merge": a PR exists and hasn't been merged → merge it now (deploy follows
 *    on the next reconcile pass).
 *  - "reconcile-only": the PR is already merged (a human beat us, or a prior
 *    approve landed) → nothing to merge; reconcile finishes the deploy.
 *  - "nothing-built": no PR was ever opened for this ticket (e.g. the build never
 *    got far enough) → approval has nothing to act on; the maintainer needs to
 *    give instructions or ask for a rebuild. */
export function decideApprove(i: { hasPr: boolean; prMerged: boolean }): "merge" | "reconcile-only" | "nothing-built" {
  if (!i.hasPr) return "nothing-built";
  return i.prMerged ? "reconcile-only" : "merge";
}
