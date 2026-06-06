import type { IntegrationProvider } from "./registry";
import type { CredentialBundle } from "./credentials";

/**
 * Split an integration's submitted install/config payload into:
 *   - `publicConfig`: the NON-secret fields — safe to persist plaintext in
 *     `Integration.config` (owner/repo/URL/etc.).
 *   - `secrets`: the SECRET fields (configField `secret:true`) — to be sealed via
 *     `setOrgCredential(orgId, provider, secrets)` and NEVER written to
 *     `Integration.config`.
 *
 * This is the chokepoint that closes the `Integration.config` plaintext-secret gap
 * (SC-28 / 800-171 3.13.16): any field a provider declares as `secret:true` is
 * stripped from the plaintext config object here and only ever reaches the vault.
 *
 * Rules:
 *   - A field is SECRET iff the provider's matching configField has `secret:true`.
 *     (`type:"secret"` is a UI hint; the SPLIT keys off `secret:true` explicitly,
 *     so a provider must opt a field into sealing — fail-safe: an un-declared field
 *     stays in publicConfig, it is never silently treated as a secret-or-not by type.)
 *   - Empty-string / null / undefined secret values are DROPPED (not sealed and not
 *     persisted) so a "config update that leaves the password blank" doesn't
 *     overwrite the existing sealed secret with an empty one. `hasSecrets` reflects
 *     only non-empty secret values.
 *   - Keys not declared in `configFields` pass through to publicConfig unchanged
 *     (backward-compatible with providers that have no configFields).
 */
export function splitConfigSecrets(
  provider: IntegrationProvider | undefined,
  submitted: Record<string, unknown>,
): { publicConfig: Record<string, unknown>; secrets: CredentialBundle; hasSecrets: boolean } {
  const secretKeys = new Set(
    (provider?.configFields ?? []).filter((f) => f.secret).map((f) => f.key),
  );

  const publicConfig: Record<string, unknown> = {};
  const secrets: CredentialBundle = {};

  for (const [key, value] of Object.entries(submitted)) {
    if (secretKeys.has(key)) {
      // Only seal a non-empty string secret; blank/undefined means "unchanged".
      if (typeof value === "string" && value.length > 0) {
        secrets[key] = value;
      }
      // Either way, NEVER copy a secret field into publicConfig.
      continue;
    }
    publicConfig[key] = value;
  }

  return { publicConfig, secrets, hasSecrets: Object.keys(secrets).length > 0 };
}
