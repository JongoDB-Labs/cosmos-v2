import type { IntegrationProvider } from "./registry";
import { outboundUrlProblem } from "@/lib/security/public-address";

/**
 * Why a submitted integration config can't be saved because of a URL in it, or
 * null. Every configField of type "url" (a Jira site, for one) is an endpoint
 * Cosmos will call, so it is checked as an admin-configured endpoint: http(s)
 * only, never a link-local or metadata address, and a private address only
 * inside the operator's OUTBOUND_ALLOW_PRIVATE_CIDRS. The call itself checks
 * again, against what the name then resolves to.
 */
export function configUrlProblem(
  provider: IntegrationProvider | undefined,
  submitted: Record<string, unknown>,
): string | null {
  for (const field of provider?.configFields ?? []) {
    if (field.type !== "url") continue;
    const value = submitted[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") return `${field.label}: Not a valid URL`;
    const problem = outboundUrlProblem(value.trim(), { allowOperatorPrivate: true });
    if (problem) return `${field.label}: ${problem}`;
  }
  return null;
}
