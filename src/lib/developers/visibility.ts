/**
 * Who may read /developers and /api/v1/openapi.json (design §3.6).
 *
 * By default, anyone signed in to this instance: the docs reveal the API's
 * shape, never data, but an instance's surface is still the operator's to
 * publish. `COSMOS_PUBLIC_API_DOCS=true` makes them public, for a commercial
 * instance that wants the API to be discoverable. Leave it unset on GOV
 * instances.
 *
 * Read on the server at request time, never inlined: this is deliberately not
 * a NEXT_PUBLIC_* variable.
 */
export const PUBLIC_DOCS_PATHS = ["/developers", "/api/v1/openapi.json"] as const;

export function publicApiDocs(): boolean {
  return process.env.COSMOS_PUBLIC_API_DOCS === "true";
}
