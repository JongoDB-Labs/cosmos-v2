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
3. Implement the SMALLEST correct change that satisfies the criteria, matching surrounding conventions.
4. Add or update a test that would have caught this. Run \`npm run typecheck && npm run lint && npm test\` and make them pass.
5. Bump the version: run \`npm version ${bump} --no-git-tag-version\`.
6. Commit to the CURRENT branch only, with a clear conventional-commit message.

## Hard limits
- Do NOT push to main, open/merge a PR, deploy, or tag — Foreman does that.
- Do NOT add any Claude/Anthropic/AI/assistant attribution to commits, code, or messages. Commit under the existing git identity only.
- If you cannot make the checks pass or the ticket is under-specified, stop and leave a commit documenting what you found rather than guessing.`;
}
