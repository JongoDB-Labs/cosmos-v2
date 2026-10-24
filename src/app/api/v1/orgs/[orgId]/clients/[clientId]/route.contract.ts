import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const updateClient = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/clients/{clientId}",
  operationId: "updateClient",
  summary: "Update a client",
  description:
    "Changes the fields given and leaves the rest alone; null clears an optional field. The name can be changed " +
    "but not cleared, and must stay unique within the organization (409 otherwise). A client of another " +
    "organization is a 404.",
  tags: ["Clients"],
  stability: "internal",
  scopes: [],
  request: {
    params: z.object({ orgId: Uuid, clientId: Uuid }),
    body: z
      .object({
        name: z.string().min(1).max(200),
        legalName: z.string().max(200).nullable(),
        email: z.string().email().max(320).nullable(),
        phone: z.string().max(60).nullable(),
        website: z.string().max(300).nullable(),
        notes: z.string().max(10000).nullable(),
        active: z.boolean(),
      })
      .partial(),
  },
  responses: {
    200: z.object({
      id: Uuid,
      name: z.string(),
      legalName: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      website: z.string().nullable(),
      notes: z.string().nullable(),
      active: z.boolean(),
    }),
  },
  errors: [400, 401, 403, 404, 409],
});
