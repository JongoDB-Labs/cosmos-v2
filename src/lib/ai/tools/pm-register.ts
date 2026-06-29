import type { ToolDefinition } from "../tools";

/**
 * PM Dashboard register tools — let the assistant read and update the govcon
 * PM registers (risks, blockers, deliverables, change requests) and drop a
 * comment on any drill-in subject. Every tool is scoped to a `projectId`; the
 * org + actor are resolved from the agent's ToolContext (same as comments).
 *
 * Writes mirror the HTTP routes under
 * `api/v1/orgs/[orgId]/projects/[projectId]/risks/…` so the auto-code, score
 * derivation, and PM activity log stay identical between human and assistant.
 */
export const pmRegisterTools: ToolDefinition[] = [
  {
    name: "list_risks",
    description:
      "List the project's risk register. Returns code, title, level, score, status, and owner for each risk (highest score first).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose risk register to list" },
        status: {
          type: "string",
          description:
            "Optional status filter: OPEN, MONITORING, MITIGATING, MITIGATED, CLOSED, ESCALATED",
        },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "create_risk",
    description:
      "Create a risk in the project's register. The R-NNN code is auto-assigned and score/level are derived from likelihood × impact (each 1-5).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID to create the risk in" },
        title: { type: "string", description: "Short risk title (max 200 chars)" },
        description: { type: "string", description: "Optional fuller description" },
        likelihood: { type: "number", description: "Likelihood 1-5 (default 1)" },
        impact: { type: "number", description: "Impact 1-5 (default 1)" },
        category: { type: "string", description: "Optional category (max 80 chars)" },
        owner: { type: "string", description: "Optional risk owner (max 120 chars)" },
        mitigation: { type: "string", description: "Optional mitigation plan" },
      },
      required: ["projectId", "title"],
    },
  },
  {
    name: "update_risk",
    description:
      "Update fields on an existing risk. Score and level are recomputed automatically when likelihood or impact change. Field changes are written to the risk's activity log.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID the risk belongs to" },
        riskId: { type: "string", description: "Risk ID to update" },
        title: { type: "string" },
        description: { type: "string" },
        likelihood: { type: "number", description: "Likelihood 1-5" },
        impact: { type: "number", description: "Impact 1-5" },
        category: { type: "string" },
        owner: { type: "string" },
        mitigation: { type: "string" },
        contingency: { type: "string" },
        status: {
          type: "string",
          description: "OPEN, MONITORING, MITIGATING, MITIGATED, CLOSED, or ESCALATED",
        },
        escalate: { type: "boolean", description: "Flag the risk for escalation" },
      },
      required: ["projectId", "riskId"],
    },
  },
  {
    name: "add_pm_comment",
    description:
      "Add a comment to a PM register subject (risk, change, blocker, milestone, deliverable, vendor, staff, or clin). The subject must belong to the project.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID the subject belongs to" },
        subjectType: {
          type: "string",
          description:
            "One of: risk, change, blocker, milestone, deliverable, vendor, staff, clin",
        },
        subjectId: { type: "string", description: "ID of the subject being commented on" },
        content: { type: "string", description: "Comment body (max 10000 chars)" },
      },
      required: ["projectId", "subjectType", "subjectId", "content"],
    },
  },
  {
    name: "list_blockers",
    description:
      "List the project's blocker register. Returns code, title, type, status, and owner for each blocker.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose blockers to list" },
        status: {
          type: "string",
          description: "Optional status filter (e.g. OPEN, RESOLVED)",
        },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "list_deliverables",
    description:
      "List the project's deliverables (CDRLs). Returns code, title, clin, status, owner, and baseline due date.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose deliverables to list" },
        status: {
          type: "string",
          description: "Optional status filter (e.g. NOT_STARTED, SUBMITTED, ACCEPTED)",
        },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "list_changes",
    description:
      "List the project's change requests. Returns code, title, type, status, cost impact, and schedule-days impact.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose change requests to list" },
        status: {
          type: "string",
          description: "Optional status filter (e.g. SUBMITTED, APPROVED, REJECTED)",
        },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: ["projectId"],
    },
  },
];
