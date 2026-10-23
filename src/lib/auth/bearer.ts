/**
 * What kind of Cosmos credential an `Authorization` header carries. Pure (no
 * prisma, no next/*), because the proxy imports it.
 *
 * Every Cosmos-issued bearer starts `cosmos_`, and the shapes cannot be
 * confused with one another:
 *
 *   api_key        cosmos_<hex prefix>_<secret>   org keys and personal tokens
 *   oauth_access   cosmos_oat_<id>_<secret>       MCP / OAuth access tokens
 *   oauth_refresh  cosmos_ort_<id>_<secret>       only ever valid at the token endpoint
 *
 * `o` is not a hex digit, so an OAuth token can never parse as a key, and a
 * key's secret is base64url (it may contain `_oat_`) but sits AFTER the hex
 * prefix, where nothing looks at it.
 *
 * A header that starts `Bearer cosmos_` but matches none of the shapes is
 * `invalid`, not null. That keeps the rule the three regexes this replaced
 * all enforced: a request presenting a Cosmos bearer authenticates by that
 * bearer or not at all — it never falls back to the session cookie riding on
 * the same request, and the proxy never applies cookie-only checks to it.
 */
export type BearerKind = "api_key" | "oauth_access" | "oauth_refresh" | "invalid";

/** `cosmos_<hex prefix>_<secret>`; the secret is the whole remainder. */
const API_KEY = /^cosmos_([0-9a-f]+)_(.+)$/;
const OAUTH = /^cosmos_(oat|ort)_([0-9a-f]+)_(.+)$/;

function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(cosmos_\S*)$/.exec((header ?? "").trim());
  return m ? m[1] : null;
}

/** null when the header carries no Cosmos bearer at all (the cookie path applies). */
export function classifyBearer(header: string | null | undefined): BearerKind | null {
  const token = bearerToken(header);
  if (token === null) return /^Bearer\s+cosmos_/.test((header ?? "").trim()) ? "invalid" : null;
  const oauth = OAUTH.exec(token);
  if (oauth) return oauth[1] === "oat" ? "oauth_access" : "oauth_refresh";
  return API_KEY.test(token) ? "api_key" : "invalid";
}

/** The prefix/secret split of an API key (or personal token) header, or null. */
export function parseApiKeyBearer(
  header: string | null | undefined,
): { prefix: string; secret: string } | null {
  if (classifyBearer(header) !== "api_key") return null;
  const m = API_KEY.exec(bearerToken(header)!);
  return m ? { prefix: m[1], secret: m[2] } : null;
}
