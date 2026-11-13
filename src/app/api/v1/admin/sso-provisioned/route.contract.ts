import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// Instance admin: accounts an organization's IdP made (User.ssoProvisioned).
// Platform admins only, from a browser session; no API key reaches it.

export const listSsoProvisionedAccounts = defineRoute({
  method: "get",
  path: "/admin/sso-provisioned",
  operationId: "listSsoProvisionedAccounts",
  summary: "List accounts made by single sign-on",
  tags: ["Instance admin"],
  stability: "internal",
  scopes: [],
  request: {},
  responses: {
    200: z.array(
      z.object({
        id: Uuid,
        email: z.string(),
        displayName: z.string(),
        createdAt: z.string(),
        orgs: z.array(z.string()),
      }),
    ),
  },
  errors: [403],
});
