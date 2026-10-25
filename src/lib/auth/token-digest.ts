import { createHash } from "node:crypto";

/**
 * The one digest of a Cosmos token's secret: how an API key is stored and
 * verified, and how the proxy names a token's rate-limit bucket. SHA-256 is
 * right here because a token is 256 random bits (`mintApiKey`), not a
 * password, so a slow hash would only add cost to every request. No imports
 * beyond node:crypto, so the proxy can use it.
 */
export function tokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
