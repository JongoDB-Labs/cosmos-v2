import { NextRequest } from "next/server";
import { success } from "@/lib/api-helpers";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { loadSchemaCustomFields } from "@/lib/query/resolve.server";
import { FIELDS } from "@/lib/query/fields";
import { FUNCTIONS } from "@/lib/query/functions";
import { CQL_LIMITS } from "@/lib/query/ast";
import { cqlErrorResponse, cqlGate } from "@/lib/query/route.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * GET — what a query can say here: system fields, the custom fields the caller
 * can see, functions and limits. No VALUES (names of people, sprints, …): those
 * come from /cql/suggest, scoped per keystroke. The editor caches this and
 * typechecks locally on every keystroke.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const gate = await cqlGate(orgId);
    if ("response" in gate) return gate.response;

    const readable = await getReadableProjectIds(gate.ctx);
    return success({
      version: 1,
      fields: FIELDS.map((f) => ({
        id: f.id,
        label: f.label,
        aliases: f.aliases,
        value: f.value,
        ops: f.ops,
        sortable: !!f.sortable,
        groupable: !!f.groupable,
        ...(f.pending ? { pending: f.pending } : {}),
        description: f.description,
      })),
      customFields: await loadSchemaCustomFields(orgId, readable),
      functions: FUNCTIONS,
      limits: CQL_LIMITS,
    });
  } catch (e) {
    return cqlErrorResponse(e);
  }
}
