// The pre-ship reviewer: an adversarial, READ-ONLY second agent that judges the
// built diff before a SAFE change may auto-ship (risky changes already get a human).
// Pure prompt + verdict-parsing here so both are unit-tested; the orchestrator
// (scripts/foreman/run.mts) owns spawning and the fail-closed retry policy.
import type { TicketBrief } from "@/lib/foreman/prompt";

export interface ReviewVerdict {
  approve: boolean;
  reason: string;
}

/** How the diff reaches the reviewer. `inline` is the normal case — SAFE diffs
 *  are ≤400 changed lines by the risk budget, so the full diff fits in the
 *  prompt and needs no file access at all. `file` is the oversized fallback;
 *  the path must be OUTSIDE the working tree (the resolved git dir) so it can
 *  never appear in the change under review. */
export type ReviewDiff = { kind: "inline"; text: string } | { kind: "file"; path: string };

/** The reviewer's instruction. It runs read-only (Read/Grep/Glob — no Bash, no
 *  edits) in the ticket's worktree, so a prompt-injected ticket can at worst sway
 *  a verdict, never touch the repo. */
export function reviewerPrompt(t: TicketBrief, diff: ReviewDiff): string {
  const criteria = t.acceptanceCriteria.length
    ? t.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
    : "- (none given — judge against the title/description)";
  return `You are an adversarial code reviewer. An automated change for ticket ${t.key} passed typecheck/lint/tests and is about to be auto-merged and deployed to production. Your job is to find a reason it should NOT ship. Only a clean change may ship.

## Ticket
${t.classification}: ${t.title}
${t.description || "(no description)"}

## Acceptance criteria
${criteria}

${
  diff.kind === "inline"
    ? `## The diff (git diff origin/main...HEAD for this build)
\`\`\`diff
${diff.text}
\`\`\`

## How to review
1. Study the diff above.`
    : `## How to review
1. Read the full diff at ${diff.path} (it is git diff origin/main...HEAD for this build).`
}
2. Read the touched files for surrounding context. You are read-only — do not attempt edits or shell commands.
3. Judge, adversarially:
   - Does the change actually satisfy the ticket + criteria, or merely appear to?
   - Does the added/updated test REALLY assert the fixed behavior (would it fail on the old code)?
   - Correctness at the edges: null/empty states, timezone/locale, pagination, concurrent updates.
   - Multi-tenancy + security: org scoping preserved, no cross-tenant data paths, no secrets, OrgMember.permissions (decimal-string mask) never serialized, no auth/permission widening.
   - Regressions: does it change behavior other surfaces rely on? Removed/renamed exports still referenced?
   - Conventions: matches the repo's patterns (org-scoped query keys, base-ui — no asChild, explicit Prisma selects).
4. Scope: flag ONLY problems that justify blocking this ship. Style nits and pre-existing issues are not blockers.

## Verdict (required)
End your reply with EXACTLY one line, as the LAST line:
APPROVE: <one-line justification>
or
REJECT: <the specific blocking problem>`;
}

/** Parse the reviewer's verdict from its transcript. Same hardened shape as the
 *  dedup judge: scan every line, anchored at line start, LAST verdict line wins
 *  (a hedged "...I would not REJECT..." mid-sentence can't register; a final
 *  reversal overrides earlier lines). FAIL-CLOSED: no verdict line at all —
 *  rambling, truncation, refusal — is a REJECT, because the reviewer is a ship
 *  gate and an unreadable gate must not open. */
export function parseReviewVerdict(log: string): ReviewVerdict {
  let verdict: ReviewVerdict = { approve: false, reason: "no verdict line from reviewer" };
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    const approve = line.match(/^APPROVE\s*:?\s*(.*)$/);
    if (approve) {
      verdict = { approve: true, reason: approve[1].trim() || "approved" };
      continue;
    }
    const reject = line.match(/^REJECT\s*:?\s*(.*)$/);
    if (reject) verdict = { approve: false, reason: reject[1].trim() || "rejected" };
  }
  return verdict;
}
