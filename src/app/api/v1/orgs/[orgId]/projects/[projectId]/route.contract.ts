import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { ProjectDetail, UpdatedProject, Uuid } from "@/lib/openapi/schemas/common";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const getProject = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}",
  operationId: "getProject",
  summary: "Get a project",
  description:
    "One project with its boards (and their columns), intervals and members. A token sees members' " +
    "`orgMember.user.email` only when it holds `members:read`; a browser session always does.",
  tags: ["Projects"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: ProjectDetail },
  errors: [400, 401, 403, 404],
  scopedFields: [{ scope: "members:read", paths: ["members[].orgMember.user.email"] }],
});

export const updateProject = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/projects/{projectId}",
  operationId: "updateProject",
  summary: "Update a project",
  description:
    "Partial update: send only the fields to change. `settings` is merged into the existing " +
    "settings, not replaced. Changing `teamScopedAccess` (who can see the project) needs a " +
    "project manager or org admin.",
  tags: ["Projects"],
  stability: "stable",
  scopes: ["items:write"],
  request: {
    params,
    body: z.object({
      name: z.string().min(1).max(100).optional(),
      description: z.string().nullish(),
      settings: z.record(z.string(), z.unknown()).optional(),
      // Null clears the client — internal and speculative work legitimately has
      // none, so "no client" has to be expressible, not just "some client".
      clientId: z.string().uuid().nullable().optional(),
      // Lifecycle state. A real enum, so an unknown spelling is a 400 here rather
      // than a value that persists and quietly fails to match any filter — which is
      // what the old `settings.status` string did.
      status: z.enum(E.ProjectStatus).optional(),
      archived: z.boolean().optional(),
      // Any strings; the route keeps only the known toggleable features. A project
      // seeded/imported with a legacy flag (e.g. a RAID board's "risk") would
      // otherwise 400 the entire update the moment the client round-trips the
      // stored array while toggling another feature on/off.
      enabledFeatures: z.array(z.string()).optional()
        .describe("Board tabs to enable. Unknown names are dropped, not rejected."),
      // Board view types this project may NOT create (opt-out; absent/empty = all
      // allowed). Persisted under settings.disabledBoardTypes.
      disabledBoardTypes: z.array(z.enum(E.BoardType)).optional(),
      // Which work-item TYPE the KR / objective link pickers offer first. A
      // `workItemTypeId`, never a constructed type key. `null` clears it. Not
      // validated against work_item_types on purpose: a retired type must degrade
      // to the fallback rather than 400 the whole update.
      krLinkTypeId: z.string().uuid().nullable().optional(),
      objectiveLinkTypeId: z.string().uuid().nullable().optional(),
      // Opt-in read narrowing (#35); see src/lib/rbac/project-access.ts.
      teamScopedAccess: z.boolean().optional(),
    }),
  },
  responses: { 200: UpdatedProject },
  errors: [400, 401, 403, 404],
});
