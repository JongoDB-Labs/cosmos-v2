import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// Instance admin: clear the made-by-single-sign-on mark on one account, when
// the admin knows its owner made it. Audited in every org the account is tied
// to. Platform admins only, from a browser session; no API key reaches it.

export const clearSsoProvisionedAccount = defineRoute({
  method: "delete",
  path: "/admin/sso-provisioned/{userId}",
  operationId: "clearSsoProvisionedAccount",
  summary: "Clear the made-by-single-sign-on mark on an account",
  tags: ["Instance admin"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ userId: Uuid }) },
  responses: { 204: null },
  errors: [403, 404],
});
