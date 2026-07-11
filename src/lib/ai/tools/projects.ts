import type { ToolDefinition } from "../tools";

export const projectTools: ToolDefinition[] = [
  {
    name: "list_projects",
    description: "List active (non-archived) projects in the org.",
    input_schema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean", description: "Include archived projects (default false)" },
      },
      required: [],
    },
  },
  {
    name: "create_project",
    description:
      "Create a new project. `key` is the uppercase project prefix (2-10 chars, unique per org) — creation fails if the key is already taken. A default board with standard columns is created.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name (max 100 chars)" },
        key: {
          type: "string",
          description: "Uppercase project key, 2-10 chars, unique per org (e.g. 'ACME')",
        },
        description: { type: "string", description: "Optional project description" },
      },
      required: ["name", "key"],
    },
  },
  {
    name: "update_project",
    description: "Update a project's name, description, or archived flag.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID to update" },
        name: { type: "string", description: "New name (max 100 chars)" },
        description: { type: "string", description: "New description" },
        archived: { type: "boolean", description: "Archive (true) or unarchive (false) the project" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "list_cycles",
    description: "List cycles for a project (optionally filtered by status).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        status: { type: "string", enum: ["PLANNED", "ACTIVE", "COMPLETED"] },
        limit: { type: "number", description: "Max results (default 20, cap 50)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "create_cycle",
    description: "Create a new cycle (sprint/phase/etc) for a project.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        name: { type: "string", description: "Cycle name" },
        startDate: { type: "string", description: "ISO datetime" },
        endDate: { type: "string", description: "ISO datetime" },
        goal: { type: "string" },
        cycleKind: {
          type: "string",
          enum: ["SPRINT", "PHASE", "MODULE", "RUN", "EVENT_DAY", "RELEASE", "ITERATION"],
          description: "Default SPRINT",
        },
      },
      required: ["projectId", "name", "startDate", "endDate"],
    },
  },
  {
    name: "update_cycle",
    description:
      "Update a cycle's fields. To nest a sprint under a Program Increment, pass `parentId` (must be a PROGRAM_INCREMENT cycle in the same project); pass null to detach. Setting status to ACTIVE fails if another cycle is already active.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID the cycle belongs to" },
        cycleId: { type: "string", description: "Cycle ID to update" },
        name: { type: "string" },
        goal: { type: "string" },
        startDate: { type: "string", description: "ISO datetime" },
        endDate: { type: "string", description: "ISO datetime" },
        status: { type: "string", enum: ["PLANNED", "ACTIVE", "COMPLETED"] },
        parentId: {
          type: "string",
          description: "Program Increment cycle id to nest under, or null to detach",
        },
      },
      required: ["projectId", "cycleId"],
    },
  },
  {
    name: "complete_cycle",
    description:
      "Complete an ACTIVE cycle. Computes a completion report (velocity, completed vs incomplete items/points). Incomplete items move to `moveIncompleteToCycleId` when supplied, otherwise return to the backlog (cycle cleared).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID the cycle belongs to" },
        cycleId: { type: "string", description: "Cycle ID to complete (must be ACTIVE)" },
        moveIncompleteToCycleId: {
          type: "string",
          description: "Optional cycle id to move incomplete items into",
        },
      },
      required: ["projectId", "cycleId"],
    },
  },
];
