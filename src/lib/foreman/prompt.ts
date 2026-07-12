export interface TicketBrief {
  key: string;
  title: string;
  description: string;
  classification: "BUG" | "FEATURE";
  acceptanceCriteria: string[];
}

/** The instruction Foreman hands the coding agent. Deterministic (no IO) so it's
 *  testable; the bump verb is derived from the ticket type per the SemVer rule. */
export function foremanPrompt(t: TicketBrief, instructions: string[] = []): string {
  const bump = t.classification === "FEATURE" ? "minor" : "patch";
  const criteria = t.acceptanceCriteria.length
    ? t.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
    : "- (none given — infer from the title/description)";
  const maintainer = instructions.length
    ? `\n## Maintainer instructions (from ticket comments — FOLLOW THESE; they override the generic approach where they conflict)\n${instructions.map((i) => `- ${i}`).join("\n")}\n`
    : "";
  return `You are an autonomous engineer implementing ${t.key} in this repository (cosmos-v2, a Next.js project-management platform).

## Ticket
${t.classification}: ${t.title}
${t.description || "(no description)"}

## Acceptance criteria
${criteria}
${maintainer}
## How to work
1. FIRST read AGENTS.md and CLAUDE.md end-to-end and obey them. This is NOT stock Next.js (Cache Components is ON), it has a strict versioning policy, base-ui (not Radix), explicit Prisma selects that exclude OrgMember.permissions, getPublicOrigin for redirects, and an authoring/attribution policy. Read the relevant node_modules/next/dist/docs guide before writing framework code.
2. Locate the exact surface this concerns. For a bug, reproduce it first; for a feature, pin the integration points.
3. Implement the SMALLEST correct change that satisfies the criteria, matching surrounding conventions. Stay tightly scoped — a change that touches auth/rbac/abac/ai-egress, prisma schema/migrations, the Dockerfile, next.config, CI workflows, or Foreman's own code (scripts/foreman, src/lib/foreman), or that sprawls across many files/lines, is auto-parked for human review instead of shipping. That gating is correct when warranted; don't sprawl into unrelated files just to avoid it.
4. Add or update a test that would have caught this. Run \`npm run typecheck && npm run lint && npm test\` and make them pass. (\`npm test\` runs against a seeded e2e database that's already wired for you.)
5. Bump the version: run \`npm version ${bump} --no-git-tag-version\`.
6. If the change is user-visible (UI, behavior, a fix a user would notice), prepend a matching entry to \`CHANGELOG\` in src/lib/changelog.ts (newest first — it drives the in-app "What's new" modal). Internal/infra-only changes don't need one.
7. Commit to the CURRENT branch only, with a clear conventional-commit message.

## Hard limits
- Do NOT push to main, open/merge a PR, deploy, or tag — Foreman does that (it opens a PR for every change; safe ones it auto-merges, risky ones it leaves for review).
- Do NOT add any Claude/Anthropic/AI/assistant attribution to commits, code, or messages. Commit under the existing git identity only.
- If you cannot make the checks pass or the ticket is under-specified, stop and leave a commit documenting what you found rather than guessing.`;
}

/** Max characters of PR diff embedded in the lost-session resume prompt — past
 *  this the diff is truncated (the agent still has the worktree to read in full). */
const RESUME_DIFF_CAP = 150_000;

/** The resume instruction for the approval loop: a ticket was built, parked for
 *  review, and the maintainer replied with steering. The SAME agent session is
 *  resumed (its previous work is already in the worktree), so this only carries
 *  the new instructions — no ticket/diff context is needed. Pure so the wording
 *  is tested; the orchestrator owns the session resume + branch/worktree. */
export function resumePrompt(key: string, instructions: string[]): string {
  const notes = instructions.length
    ? instructions.map((i) => `- ${i}`).join("\n")
    : "- (no specific notes — re-verify the change still holds and address any obvious gap)";
  return `You built ${key} and it was parked for review. The maintainer replied:
${notes}

Apply these instructions in the current worktree (your previous session's work). Re-run relevant tests. Update version/changelog only if the change's nature demands it. Commit when done.

## Hard limits (unchanged)
- Do NOT push to main, open/merge a PR, deploy, or tag — Foreman does that.
- Do NOT add any Claude/Anthropic/AI/assistant attribution to commits, code, or messages. Commit under the existing git identity only.
- Stay on the CURRENT branch; do not start over or revert unrelated work.`;
}

/** The lost-session fallback for resumePrompt: when the original agent session
 *  can't be resumed (no sessionId persisted, or the resume errored), a FRESH
 *  agent is given the same instructions PLUS the original ticket brief and the
 *  current PR diff so it can reconstruct the context. The diff is capped at
 *  RESUME_DIFF_CAP chars (the agent can still read the full tree from its cwd).
 *  Pure so the framing + truncation note are tested. */
export function resumeContextPrompt(
  brief: { key: string; title: string; description: string },
  prDiff: string,
  instructions: string[],
): string {
  const notes = instructions.length
    ? instructions.map((i) => `- ${i}`).join("\n")
    : "- (no specific notes — re-verify the change still holds and address any obvious gap)";
  const truncated = prDiff.length > RESUME_DIFF_CAP;
  const diff = truncated
    ? prDiff.slice(0, RESUME_DIFF_CAP) + "\n… [diff truncated — read the full change from the worktree]"
    : prDiff;
  return `You built ${brief.key} and it was parked for review. The maintainer replied:
${notes}

Your original session could not be resumed, so here is the context to pick up where it left off.

## Original ticket
${brief.title}
${brief.description || "(no description)"}

## Current PR diff:
\`\`\`diff
${diff}
\`\`\`

Apply these instructions in the current worktree (your previous session's work is already committed on this branch). Re-run relevant tests. Update version/changelog only if the change's nature demands it. Commit when done.

## Hard limits (unchanged)
- Do NOT push to main, open/merge a PR, deploy, or tag — Foreman does that.
- Do NOT add any Claude/Anthropic/AI/assistant attribution to commits, code, or messages. Commit under the existing git identity only.
- Stay on the CURRENT branch; do not start over or revert unrelated work.`;
}

/** The repair-round instruction: the SAME agent session (resumed, full context of
 *  what it built and why) is told exactly what failed and to fix forward. Pure so
 *  the wording is tested; the orchestrator bounds the number of rounds. */
export function repairPrompt(key: string, checkLogTail: string): string {
  return `Your change for ${key} FAILS the pre-ship checks. Fix it in this same worktree — do not start over, do not revert unrelated work.

## Failing check output (tail)
${checkLogTail}

## How to repair
1. Diagnose from the output above; reproduce locally (\`npm run typecheck && npm run lint && npm test\` — the e2e test database is already wired).
2. Make the SMALLEST fix that turns the checks green. If the failure is in a test you added, fix the test to genuinely assert the behavior — never weaken or delete an existing test to force a pass.
3. Do NOT bump the version again: package.json must stay exactly ONE bump ahead of main from your original change.
4. Re-run the checks yourself until green, then commit the fix to the CURRENT branch (a new commit is fine).
5. The hard limits from your original instructions still apply (no push/PR/deploy/tag, no attribution, current branch only).`;
}
