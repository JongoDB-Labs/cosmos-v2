/**
 * How the saved-view routes answer what `saved-view-service.server.ts` throws:
 * the exact responses they sent before the gates moved there. Kept apart from
 * the service so the assistant's tools, which call the service too, don't pull
 * in the routes' response helpers.
 */
import { handleApiError } from "@/lib/api-helpers";
import { cqlErrorResponse } from "./route.server";
import { SavedViewCqlError, SavedViewNotFound, SavedViewRefusal } from "./saved-view-service.server";

export function savedViewErrorResponse(error: unknown): Response {
  if (error instanceof SavedViewNotFound) return new Response("Not found", { status: 404 });
  if (error instanceof SavedViewRefusal) {
    return new Response(JSON.stringify({ error: error.message }), { status: error.status, headers: { "Content-Type": "application/json" } });
  }
  if (error instanceof SavedViewCqlError) return cqlErrorResponse(error.cqlError);
  return handleApiError(error);
}
