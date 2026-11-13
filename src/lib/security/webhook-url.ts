import { z } from "zod";
import { outboundUrlProblem } from "./public-address";

/**
 * The check a URL Cosmos will send to (a webhook, Cosmo's fetch_url) passes
 * when it is given. It sees only the text: an address WRITTEN into the URL, in
 * any spelling the URL parser accepts (`[::ffff:127.0.0.1]`, `2130706433`), is
 * held to the same list the send path uses; a NAME is checked when the request
 * is sent, against every address it then resolves to, and the connection is
 * pinned to the address checked (outbound-post.server.ts). So this is the
 * early, readable refusal, not the only one.
 */
export const webhookUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine(
    // A webhook is held to the public-only policy: never a private address,
    // whatever ranges the operator opened for configured integrations.
    (u) => outboundUrlProblem(u) === null,
    "Webhook URL must be a public http(s) endpoint (no localhost, private IPs, or file://)",
  );

/**
 * A webhook URL as an audit row may keep it: the origin only. The path and
 * query can be the credential itself (a chat tool's incoming-webhook path is),
 * and audit rows are kept for years and exported.
 */
export function auditableUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(not a valid URL)";
  }
}
