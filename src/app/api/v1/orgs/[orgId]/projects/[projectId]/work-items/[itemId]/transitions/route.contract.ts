import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { STATUS_CATEGORIES } from "../../../statuses/route.contract";

const FieldRef = z
  .union([z.object({ system: z.string() }), z.object({ custom: z.string() })])
  .describe("A system field (`{ system: \"resolution\" }`) or a custom field by key (`{ custom: \"root_cause\" }`).");

export const Transition = z
  .object({
    id: z.string().describe("Send as `transition.id` with the move to take this transition."),
    name: z.string().meta({ example: "Resolve" }),
    to: z.string().describe("The status key the transition leads to.").meta({ example: "done" }),
    toCategory: z.enum(STATUS_CATEGORIES),
    input: z
      .array(
        z.object({
          field: FieldRef,
          required: z.boolean(),
          label: z.string().optional(),
          options: z.array(z.object({ value: z.string(), label: z.string(), hint: z.string().optional() })).optional(),
        }),
      )
      .describe(
        "Fields the transition asks for. Send their values as `transition.input`, keyed " +
          "`system:<field>` or `custom:<key>`; a move without a required one is refused with " +
          "`transition_input_required` and this same list.",
      ),
  })
  .meta({ id: "Transition" });

export const listItemTransitions = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/transitions",
  operationId: "listItemTransitions",
  summary: "List the transitions available on a work item",
  description:
    "The status changes the caller may make on the item from its current status, under the " +
    "workflow that governs the item's project and type, with what each asks for. Restrictions are " +
    "already applied; a transition's checks run when the move is made.",
  tags: ["Workflows"],
  stability: "beta",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid }) },
  responses: { 200: z.array(Transition) },
  errors: [401, 403, 404],
});
