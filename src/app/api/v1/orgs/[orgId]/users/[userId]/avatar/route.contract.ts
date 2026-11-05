import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

// One user's avatar, as image bytes.
//
// Avatars are stored as `data:` URIs. Inlined in every payload that names a
// user, three of them were 93% of a 171KB members response, and base64 does
// not compress. `avatarSrc()` points `avatarUrl` here instead, so the bytes
// travel once and the browser reuses them wherever that user appears.
//
// Internal: the body is image bytes, which this pipeline has no way to
// describe, so it is kept out of the public spec. `200: z.string()` follows
// the convention the HTML-answering routes already use for a non-JSON body —
// nothing validates against it, because the handler answers with a Response
// of its own rather than through `respond()`.
//
// `scopes: ["read"]` mirrors listMembers. A key that can read the members
// list receives avatar URLs from it, so it must be able to fetch them --
// before this endpoint those bytes came inline, and refusing the key here
// would take a capability away (src/lib/auth/__tests__/scope-compat.test.ts).

const params = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() });

export const getUserAvatar = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/users/{userId}/avatar",
  operationId: "getUserAvatar",
  summary: "Fetch a user's avatar image",
  description:
    "Answers the stored avatar as image bytes, cacheable immutably because the "
    + "URL carries a hash of the content. 404 when the user has no avatar, is "
    + "not a member of this org, or stored one this endpoint will not serve.",
  tags: ["Members"],
  stability: "internal",
  scopes: ["read"],
  request: { params },
  responses: { 200: z.string() },
  errors: [401, 404],
});
