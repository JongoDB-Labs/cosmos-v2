import type { ToolDefinition } from "../tools";

/**
 * Goals + KPIs tools — project delivery goals (with manual/auto progress) and
 * KPIs (with a target/current value + direction). Mirrors the routes under
 * `api/v1/orgs/[orgId]/projects/[projectId]/goals|kpis/…`.
 *
 * No dedicated GOAL or KPI permission bits exist, so both use the OKR bits
 * (OKR_READ/CREATE/UPDATE) — the closest existing planning-domain grants.
 */
export const goalsKpisTools: ToolDefinition[] = [
  {
    name: "list_goals",
    description: "List a project's goals (status, progress, target date; AUTO goals roll up from links).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose goals to list" },
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "create_goal",
    description: "Create a goal in a project.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID to create the goal in" },
        title: { type: "string", description: "Goal title (max 200 chars)" },
        description: { type: "string", description: "Optional description" },
        status: { type: "string", enum: ["PLANNED", "ON_TRACK", "AT_RISK", "OFF_TRACK", "ACHIEVED"] },
        targetDate: { type: "string", description: "Optional ISO datetime" },
        progressMode: { type: "string", enum: ["MANUAL", "AUTO"], description: "Default MANUAL" },
        ownerId: { type: "string", description: "Optional owner user ID" },
      },
      required: ["projectId", "title"],
    },
  },
  {
    name: "update_goal",
    description: "Update a goal's fields.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID the goal belongs to" },
        goalId: { type: "string", description: "Goal ID to update" },
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["PLANNED", "ON_TRACK", "AT_RISK", "OFF_TRACK", "ACHIEVED"] },
        progress: { type: "number", description: "Manual progress 0-100" },
        targetDate: { type: "string", description: "ISO datetime, or null to clear" },
        ownerId: { type: "string" },
      },
      required: ["projectId", "goalId"],
    },
  },
  {
    name: "list_kpis",
    description: "List a project's KPIs (unit, target/current value, direction; auto-source KPIs derive on read).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose KPIs to list" },
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "create_kpi",
    description: "Create a KPI in a project.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID to create the KPI in" },
        name: { type: "string", description: "KPI name (max 200 chars)" },
        description: { type: "string", description: "Optional description" },
        unit: { type: "string", description: "Optional unit label (max 50 chars)" },
        targetValue: { type: "number", description: "Target value (default 0)" },
        currentValue: { type: "number", description: "Current value (default 0)" },
        direction: { type: "string", enum: ["UP_GOOD", "DOWN_GOOD"], description: "Default UP_GOOD" },
      },
      required: ["projectId", "name"],
    },
  },
  {
    name: "update_kpi",
    description: "Update a KPI's fields.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID the KPI belongs to" },
        kpiId: { type: "string", description: "KPI ID to update" },
        name: { type: "string" },
        description: { type: "string" },
        unit: { type: "string" },
        targetValue: { type: "number" },
        currentValue: { type: "number" },
        direction: { type: "string", enum: ["UP_GOOD", "DOWN_GOOD"] },
      },
      required: ["projectId", "kpiId"],
    },
  },
];
