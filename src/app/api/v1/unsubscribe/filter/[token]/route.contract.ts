import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

// One-click unsubscribe from a filter email (query design §11.2): the token in
// the link is the credential, no session. GET answers a confirmation page;
// only its POST acts. Both answer HTML.

const params = z.object({ token: z.string().max(200) });

export const confirmFilterUnsubscribe = defineRoute({
  method: "get",
  path: "/unsubscribe/filter/{token}",
  operationId: "confirmFilterUnsubscribe",
  summary: "Ask to confirm unsubscribing from a filter email",
  tags: ["Saved filters"],
  stability: "internal",
  scopes: [],
  request: { params },
  responses: { 200: z.string() },
  errors: [404],
});

export const filterUnsubscribe = defineRoute({
  method: "post",
  path: "/unsubscribe/filter/{token}",
  operationId: "filterUnsubscribe",
  summary: "Unsubscribe from a filter email",
  tags: ["Saved filters"],
  stability: "internal",
  scopes: [],
  request: { params },
  responses: { 200: z.string() },
  errors: [404],
});
