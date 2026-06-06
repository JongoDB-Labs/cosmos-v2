import type { ToolDefinition } from "../tools";

/**
 * GitHub tool catalog for the AI assistant — READ-ONLY (issues + pull requests).
 *
 * These tools require the ORG to have connected GitHub via the integrations page
 * (a fine-grained Personal Access Token sealed into the org-level vault credential;
 * see `src/lib/integrations/credentials.ts` getOrgCredential + the install/config
 * secret split). The token is org-shared, NOT per-user. Each tool's executor lives
 * in `src/lib/ai/executors/github.ts` — dispatched from `src/lib/ai/tool-executor.ts`.
 *
 * `owner`/`repo` default to the integration's configured `defaultOwner`/`defaultRepo`
 * when omitted, so the assistant can say "list open issues" without restating them.
 *
 * Write tools (create/close issue) are intentionally DEFERRED — read-only first
 * keeps the blast radius minimal. Results flow through the egress chokepoint: gov
 * tenants see structural fields only (number/state/timestamps), never title/body.
 */
export const githubTools: ToolDefinition[] = [
  {
    name: "github_list_issues",
    description:
      "List issues in a GitHub repository (read-only). Returns each issue's number, state, title, labels, and timestamps. Excludes pull requests. Use github_get_issue for a single issue's full body. Owner/repo default to the connected integration's configured defaults when omitted.",
    input_schema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description:
            "Repository owner (user or org login). Omit to use the integration's default owner.",
        },
        repo: {
          type: "string",
          description:
            "Repository name. Omit to use the integration's default repo.",
        },
        state: {
          type: "string",
          description: "Filter by state: 'open' (default), 'closed', or 'all'.",
        },
        limit: {
          type: "integer",
          description: "Max issues to return (default 20, max 50).",
        },
      },
      required: [],
    },
  },
  {
    name: "github_get_issue",
    description:
      "Get a single GitHub issue by number (read-only). Returns its number, state, title, body, labels, and timestamps. Owner/repo default to the connected integration's configured defaults when omitted.",
    input_schema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description:
            "Repository owner (user or org login). Omit to use the integration's default owner.",
        },
        repo: {
          type: "string",
          description:
            "Repository name. Omit to use the integration's default repo.",
        },
        number: {
          type: "integer",
          description: "The issue number (e.g. 42).",
        },
      },
      required: ["number"],
    },
  },
  {
    name: "github_list_pull_requests",
    description:
      "List pull requests in a GitHub repository (read-only). Returns each PR's number, state, title, draft flag, and timestamps. Owner/repo default to the connected integration's configured defaults when omitted.",
    input_schema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description:
            "Repository owner (user or org login). Omit to use the integration's default owner.",
        },
        repo: {
          type: "string",
          description:
            "Repository name. Omit to use the integration's default repo.",
        },
        state: {
          type: "string",
          description: "Filter by state: 'open' (default), 'closed', or 'all'.",
        },
        limit: {
          type: "integer",
          description: "Max pull requests to return (default 20, max 50).",
        },
      },
      required: [],
    },
  },
];
