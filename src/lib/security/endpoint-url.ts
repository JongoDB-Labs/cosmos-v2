import { z } from "zod";
import { outboundUrlProblem } from "./public-address";

/**
 * A URL an org admin configures for Cosmos to call (an OpenAI-compatible model
 * endpoint, an MCP server): http(s), never a link-local or cloud metadata
 * address, and a private address only inside the operator's
 * OUTBOUND_ALLOW_PRIVATE_CIDRS. A name is checked again when it is called,
 * against every address it then resolves to; this is the early refusal.
 */
export function endpointUrlSchema(max = 2000) {
  return z
    .string()
    .trim()
    .url("A valid URL is required")
    .max(max)
    .superRefine((url, ctx) => {
      const problem = outboundUrlProblem(url, { allowOperatorPrivate: true });
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    });
}
