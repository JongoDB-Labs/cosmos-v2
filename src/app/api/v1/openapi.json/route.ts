import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { publicApiDocs } from "@/lib/developers/visibility";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { userContext } from "@/lib/openapi/user-context";
import spec from "../../../../../openapi/cosmos-v1.json";
import { getOpenApiDocument } from "./route.contract";

/**
 * The committed spec, bundled at build time. Not built from the contracts at
 * request time: the generator (@asteasolutions/zod-to-openapi) is a dev
 * dependency, and CI already holds this file equal to what the contracts
 * build (scripts/openapi/check.mjs). The internal surface is not served; a
 * developer gets it from `npm run openapi` (openapi/cosmos-v1.internal.json).
 */
export async function GET(request: NextRequest) {
  try {
    await parseRequest(getOpenApiDocument, request);
    // Anyone who can sign in to this instance, by session or by token, unless
    // the operator made the docs public. The proxy has already turned away
    // requests with neither, but lets any `cosmos_` bearer through for the
    // route to verify.
    if (!publicApiDocs()) await userContext(getOpenApiDocument);
    return respond(getOpenApiDocument, 200, spec);
  } catch (e) {
    return handleApiError(e, request);
  }
}
