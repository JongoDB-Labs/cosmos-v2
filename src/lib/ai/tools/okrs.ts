import type { ToolDefinition } from "../tools";

/**
 * OKR tools — read/write objectives, key results, check-ins, and KR↔work-item
 * links. Objectives are project-scoped; key results hang off an objective; a
 * check-in folds a new value/confidence/stoplight into the KR's live snapshot
 * and re-rolls the parent objective's progress. Mirrors the routes under
 * `api/v1/orgs/[orgId]/projects/[projectId]/objectives|key-results/…`.
 */
export const okrTools: ToolDefinition[] = [
  {
    name: "list_objectives",
    description:
      "List objectives with their key results, rolled-up progress (0-100), and health (on-track / at-risk / behind). Optionally scope to one project.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Optional project ID to scope to (else all org projects)" },
        limit: { type: "number", description: "Max objectives (default 50, cap 100)" },
      },
      required: [],
    },
  },
  {
    name: "create_objective",
    description: "Create an objective in a project.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID to create the objective in" },
        title: { type: "string", description: "Objective title (max 200 chars)" },
        description: { type: "string", description: "Optional description" },
        targetDate: { type: "string", description: "Optional ISO datetime target/end date (drives health)" },
      },
      required: ["projectId", "title"],
    },
  },
  {
    name: "update_objective",
    description: "Update an objective's title, description, target date, or status.",
    input_schema: {
      type: "object",
      properties: {
        objectiveId: { type: "string", description: "Objective ID to update" },
        title: { type: "string" },
        description: { type: "string" },
        targetDate: { type: "string", description: "ISO datetime, or null to clear" },
        status: { type: "string", enum: ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"] },
      },
      required: ["objectiveId"],
    },
  },
  {
    name: "delete_objective",
    description: "Delete an objective. Its key results cascade-delete.",
    input_schema: {
      type: "object",
      properties: {
        objectiveId: { type: "string", description: "Objective ID to delete" },
      },
      required: ["objectiveId"],
    },
  },
  {
    name: "create_key_result",
    description: "Add a key result to an objective. Progress derives from start → current → target value.",
    input_schema: {
      type: "object",
      properties: {
        objectiveId: { type: "string", description: "Objective ID the KR belongs to" },
        title: { type: "string", description: "Key result title (max 200 chars)" },
        targetValue: { type: "number", description: "Target value (default 100)" },
        startValue: { type: "number", description: "Baseline value (default 0)" },
        currentValue: { type: "number", description: "Current value (default 0)" },
        unit: { type: "string", description: "Optional unit label (max 40 chars)" },
        lowerIsBetter: { type: "boolean", description: "True when the metric improves as it goes down" },
      },
      required: ["objectiveId", "title"],
    },
  },
  {
    name: "update_key_result",
    description:
      "Update a key result's title, values, or status. The parent objective's progress is recomputed.",
    input_schema: {
      type: "object",
      properties: {
        keyResultId: { type: "string", description: "Key result ID to update" },
        title: { type: "string" },
        currentValue: { type: "number" },
        targetValue: { type: "number" },
        startValue: { type: "number" },
        unit: { type: "string" },
        status: {
          type: "string",
          enum: ["NOT_STARTED", "IN_PROGRESS", "AT_RISK", "ON_TRACK", "DONE"],
        },
      },
      required: ["keyResultId"],
    },
  },
  {
    name: "add_kr_checkin",
    description:
      "Record a check-in on a key result: a point-in-time value plus confidence (0-100) and stoplight (GREEN/YELLOW/RED). Folds into the KR's live snapshot and re-rolls the objective's progress. When `rag` is omitted it is derived from confidence.",
    input_schema: {
      type: "object",
      properties: {
        keyResultId: { type: "string", description: "Key result ID to check in on" },
        value: { type: "number", description: "The KR's value at this check-in" },
        confidence: { type: "number", description: "Confidence 0-100 (default 50)" },
        rag: { type: "string", enum: ["GREEN", "YELLOW", "RED"], description: "Stoplight (else derived from confidence)" },
        note: { type: "string", description: "Optional note (max 2000 chars)" },
      },
      required: ["keyResultId", "value"],
    },
  },
  {
    name: "link_key_result_item",
    description:
      "Link a work item to a key result (idempotent). When a KR has ≥1 linked item, its progress auto-tracks how many are done. Both must be in the same project.",
    input_schema: {
      type: "object",
      properties: {
        keyResultId: { type: "string", description: "Key result ID" },
        workItemId: { type: "string", description: "Work item ID to link (same project as the KR)" },
      },
      required: ["keyResultId", "workItemId"],
    },
  },
];
