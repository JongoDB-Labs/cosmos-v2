import type { ToolDefinition } from "../tools";

/**
 * Jira (Cloud) tool catalog for the AI assistant — READ-focused + one safe write.
 *
 * These tools require the ORG to have connected Jira via the integrations page
 * (an Atlassian account email + an API token; the token is sealed into the org-level
 * vault credential — see `src/lib/integrations/credentials.ts` getOrgCredential + the
 * install/config secret split). The credential is org-shared, NOT per-user. Each
 * tool's executor lives in `src/lib/ai/executors/jira.ts` — dispatched from
 * `src/lib/ai/tool-executor.ts` via the connector registry.
 *
 * `projectKey` defaults to the integration's configured `defaultProjectKey` when
 * omitted, so the assistant can say "list issues in the project" without restating it.
 *
 * Results flow through the egress chokepoint: gov tenants see STRUCTURAL fields only
 * (issue key/status/priority/issueType/timestamps; project id/key/type), never the
 * summary, description, comments, labels, or any reporter/assignee name/email (PII).
 */
export const jiraTools: ToolDefinition[] = [
  {
    name: "jira_search_issues",
    description:
      "Search Jira Cloud issues (read-only). Provide a raw JQL string, OR a projectKey + optional status/assigneeAccountId filters which are composed into JQL. Returns each issue's key, status, priority, issue type, and timestamps. Use jira_get_issue for a single issue. projectKey defaults to the connected integration's configured default when omitted.",
    input_schema: {
      type: "object",
      properties: {
        jql: {
          type: "string",
          description:
            "A raw JQL query (e.g. \"project = ABC AND status = 'In Progress' ORDER BY created DESC\"). When provided, it takes precedence over the simple filters below.",
        },
        projectKey: {
          type: "string",
          description:
            "Project key to filter by (e.g. 'ABC'). Omit to use the integration's default project key. Ignored when `jql` is provided.",
        },
        status: {
          type: "string",
          description:
            "Filter by status name (e.g. 'To Do', 'In Progress', 'Done'). Ignored when `jql` is provided.",
        },
        assigneeAccountId: {
          type: "string",
          description:
            "Filter by assignee Atlassian account id (opaque). Ignored when `jql` is provided.",
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
    name: "jira_get_issue",
    description:
      "Get a single Jira Cloud issue by key (read-only). Returns its key, status, priority, issue type, and timestamps. (The summary/description are fetched but withheld from the model for gov tenants by the egress gate.)",
    input_schema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: "The issue key (e.g. 'ABC-123').",
        },
      },
      required: ["issueKey"],
    },
  },
  {
    name: "jira_list_projects",
    description:
      "List Jira Cloud projects the connected account can see (read-only). Returns each project's id, key, and project type. Use a project key with jira_search_issues / jira_create_issue.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Max projects to return (default 20, max 50).",
        },
      },
      required: [],
    },
  },
  {
    name: "jira_create_issue",
    description:
      "Create a new Jira Cloud issue (the one write tool). Requires projectKey, summary, and issueType (e.g. 'Task', 'Bug', 'Story'). An optional description may be supplied. Returns the created issue's key. projectKey defaults to the integration's configured default when omitted.",
    input_schema: {
      type: "object",
      properties: {
        projectKey: {
          type: "string",
          description:
            "Project key to create the issue in (e.g. 'ABC'). Omit to use the integration's default project key.",
        },
        summary: {
          type: "string",
          description: "The issue summary (title).",
        },
        issueType: {
          type: "string",
          description: "The issue type name (e.g. 'Task', 'Bug', 'Story').",
        },
        description: {
          type: "string",
          description: "Optional plain-text description for the issue body.",
        },
      },
      required: ["summary", "issueType"],
    },
  },
];
