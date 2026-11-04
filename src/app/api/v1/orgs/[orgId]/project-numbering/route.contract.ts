import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const Settings = z.object({
  pattern: z.string().nullable().describe("e.g. YY-NNN. Null: projects aren't numbered."),
  namePattern: z.string().nullable().describe("e.g. {number} {name}. Null: names are used as typed."),
});

const params = z.object({ orgId: Uuid });

export const getProjectNumbering = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/project-numbering",
  operationId: "getProjectNumbering",
  summary: "Get the org's project numbering standard",
  description: "With `next`, the number a project created now would get.",
  tags: ["Projects"],
  stability: "internal",
  scopes: ["read"],
  request: { params },
  responses: { 200: Settings.extend({ next: z.string().nullable(), canManage: z.boolean() }) },
  errors: [401, 403, 404],
});

export const updateProjectNumbering = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/project-numbering",
  operationId: "updateProjectNumbering",
  summary: "Change the org's project numbering standard",
  description: "Needs org-settings permission. Fields left out keep their value; null turns one off.",
  tags: ["Projects"],
  stability: "internal",
  // No API-key scope grants org settings: a signed-in admin only.
  scopes: [],
  request: { params, body: Settings.partial() },
  responses: { 200: Settings.extend({ next: z.string().nullable() }) },
  errors: [400, 401, 403, 404],
});
