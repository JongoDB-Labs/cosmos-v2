// src/lib/ai/connectors/github.descriptor.ts
//
// GitHub (read-only issues + PRs) expressed as a ConnectorDescriptor — a pure
// re-expression of the EXISTING wiring (tools/github.ts defs + executors/github.ts
// dispatch). No tool logic is rewritten; the descriptor only references them.
//
// EGRESS — moved verbatim out of egress/projection.ts INTO this descriptor (the
// registry merges it back into the global maps, net effect identical):
//   - TOOL_ENTITY:      github_list_issues/github_get_issue → github_issue;
//                       github_list_pull_requests           → github_pull_request.
//   - EXPOSABLE_FIELDS: structural-ONLY (number/state/draft/timestamps). title/body
//                       are content (worst-case CUI in a connected repo) → WITHHELD;
//                       labels (array) dropped by convention; no login/PII field.
//   - HANDLEABLE_FIELDS: NONE — github has no handleable CUI string field today
//                       (the model orchestrates GitHub work BY NUMBER under the MAC
//                       ceiling, never by referencing a title/body). Omitted on
//                       purpose ⇒ no handles minted for github (unchanged).
//
// A gov tenant therefore sees issue/PR numbers + state + timestamps and never the
// title/body — exactly as before this refactor.

import type { ConnectorDescriptor } from "./types";
import { githubTools } from "../tools/github";
import { executeGitHubTool } from "../executors/github";

export const githubConnector: ConnectorDescriptor = {
  provider: "github",
  toolDefs: githubTools,
  execute: (name, input, ctx) =>
    executeGitHubTool(name, input, { userId: ctx.userId, orgId: ctx.orgId }),
  egress: {
    github_list_issues: { entityType: "github_issue" },
    github_get_issue: { entityType: "github_issue" },
    github_list_pull_requests: { entityType: "github_pull_request" },
  },
  exposableFields: {
    // GitHub issues (githubListIssues/githubGetIssue) return `number, state, title,
    // body?, labels, createdAt, updatedAt, closedAt`. Structural ONLY: number + state
    // (enum) + timestamps — the agent orchestrates GitHub work BY NUMBER under the MAC
    // ceiling. `title`/`body` are content (worst-case CUI in a connected repo) → WITHHELD.
    // `labels` is an array → DROPPED by convention (could carry free-text). No login/PII
    // field is exposed (we never surfaced assignee/author logins to the model).
    github_issue: ["number", "state", "createdAt", "updatedAt", "closedAt"],
    // GitHub pull requests (githubListPullRequests) return `number, state, title, draft,
    // createdAt, updatedAt, closedAt, mergedAt`. Structural ONLY: number + state + the
    // `draft` boolean + timestamps. `title` is content → WITHHELD.
    github_pull_request: ["number", "state", "draft", "createdAt", "updatedAt", "closedAt", "mergedAt"],
  },
  // No handleableFields: github has no handleable CUI string field (see header).
};
