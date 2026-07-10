export interface TicketBrief {
  key: string;
  title: string;
  description: string;
  classification: "BUG" | "FEATURE";
  acceptanceCriteria: string[];
}

/** The instruction Foreman hands the coding agent. Deterministic (no IO) so it's
 *  testable; the bump verb is derived from the ticket type per the SemVer rule. */
export function foremanPrompt(t: TicketBrief): string {
  const bump = t.classification === "FEATURE" ? "minor" : "patch";
  const criteria = t.acceptanceCriteria.length
    ? t.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
    : "- (none given — infer from the title/description)";
  return `You are an autonomous engineer implementing ${t.key} in this repository (cosmos-v2, a Next.js project-management platform).

## Ticket
${t.classification}: ${t.title}
${t.description || "(no description)"}

## Acceptance criteria
${criteria}

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
