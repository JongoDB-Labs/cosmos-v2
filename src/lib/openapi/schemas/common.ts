import { z } from "zod";
import { PROBLEM_CODES } from "../problem-codes";

/**
 * Shared component schemas: the wire shapes the published spec names (each
 * `.meta({ id })` becomes `#/components/schemas/<id>`), and the shapes MCP's
 * `outputSchema` will reuse. Response schemas strip, so a field missing here
 * is a field the API doesn't return. Add it deliberately.
 *
 * Pure zod: these are imported by contract files, which the spec build runs in
 * plain node. Enum values are written out rather than imported from
 * @prisma/client for the same reason; `schemas.test.ts` pins them to Prisma's.
 */

/** Any 8-4-4-4-12 hex id. Not RFC-strict `z.uuid()`: rows seeded or imported
 *  with non-v4 ids are real, and a response schema that refused them would
 *  turn a valid row into a 500. */
export const Uuid = z.guid().meta({ id: "Uuid", example: "0b8f6c1e-6a52-4bd0-9b0e-3a4c2f6d1e7a" });

/** Inline, not `Uuid.nullable()`: a nullable $ref renders as
 *  `allOf: [Uuid, string|null]`, which no `null` can satisfy. */
export const NullableUuid = z.guid().nullable();

/** Timestamps are ISO 8601 UTC strings on the wire. */
export const IsoDateTime = z.iso.datetime({ offset: true })
  .meta({ id: "IsoDateTime", example: "2026-11-01T09:30:00.000Z" });

export const Problem = z.object({
  type: z.string().describe("Relative URI of this code in the errors guide."),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: z.enum(Object.keys(PROBLEM_CODES) as [keyof typeof PROBLEM_CODES, ...(keyof typeof PROBLEM_CODES)[]]),
  requestId: z.string().optional().describe("The `X-Request-Id` of the request. Quote it to support."),
  issues: z.array(z.unknown()).optional().describe("Validation failures, on 400 `invalid_request`."),
  error: z.string().describe("Deprecated: same text as `detail` (or `title`). Kept for existing clients."),
}).meta({ id: "Problem", description: "RFC 9457 problem details (`application/problem+json`)." });

export const PROJECT_STATUSES = ["DRAFT", "ACTIVE", "ON_HOLD", "COMPLETE"] as const;

export const Project = z.object({
  id: Uuid,
  orgId: Uuid,
  name: z.string(),
  key: z.string().describe("Short uppercase key; ticket ids are `<key>-<number>`."),
  description: z.string().nullable(),
  status: z.enum(PROJECT_STATUSES),
  archived: z.boolean(),
  settings: z.record(z.string(), z.unknown()).describe("Board and display settings."),
  projectTemplateId: NullableUuid,
  enabledFeatures: z.array(z.string()).describe("Optional board tabs this project has switched on."),
  sector: z.string().nullable().describe("Sector of the template the project was created from."),
  teamScopedAccess: z.boolean().describe("Only project members (and org admins) can see it."),
  clientId: NullableUuid,
  externalRef: z.string().nullable(),
  krLinkTypeId: NullableUuid,
  objectiveLinkTypeId: NullableUuid,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  _count: z.object({ boards: z.number().int(), intervals: z.number().int(), members: z.number().int() }),
}).meta({ id: "Project" });
