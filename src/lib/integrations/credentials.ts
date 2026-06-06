import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import { sealSecret, openSecret } from "@/lib/crypto/vault";

/**
 * Connector credential accessor — the connector layer's single, org-scoped,
 * vault-sealed credential path (SC-28 / 800-171 3.13.16 protect-at-rest; IA-5;
 * 3.5.10 store only cryptographically-protected secrets).
 *
 * External connector credentials (Google OAuth refresh tokens first; API keys /
 * access tokens for future providers) live in the `connector_credentials` table
 * as AES-256-GCM vault envelopes (`v2.<kid>.<iv>.<tag>.<ct>`) sealed via
 * `src/lib/crypto/vault.ts` — the SAME rotatable keyring that seals OIDC client
 * secrets, so `scripts/dsop/rotate-vault-key.mjs` re-wraps connector creds too.
 *
 * INVARIANTS (gov / no-CUI-or-secret-leak):
 *   - The plaintext secret bundle is sealed BEFORE it touches the DB and opened
 *     ONLY here, server-side, at call time. It is NEVER returned to a client or
 *     the model — callers receive the bundle and use it to mint a provider client.
 *   - We NEVER log the bundle or the sealed `secret_enc`.
 *   - Access is per (org, provider, user). Callers MUST pass the caller's org —
 *     this layer does not widen scope.
 *
 * The sealed bundle is a flat string→string map (e.g. `{ refreshToken }`,
 * `{ apiKey }`, `{ accessToken, refreshToken }`). `meta` is NON-secret hints
 * (scopes, account email, expiry) safe to persist unsealed.
 */

/** The decrypted secret bundle — a flat map of secret values (never logged/returned to clients). */
export type CredentialBundle = Record<string, string>;

/**
 * Read + unseal a connector credential. Returns the decrypted secret bundle for
 * (orgId, provider, userId), or `null` when no row exists.
 *
 * The unsealed bundle is intended for immediate server-side use (e.g. minting an
 * OAuth client). Do NOT pass it to a client or include it in a model-visible
 * payload. Throws only if the stored envelope fails to open (tampered / wrong key
 * / retired kid) — a real integrity signal that must surface, not be swallowed.
 */
export async function getCredential(
  orgId: string,
  provider: string,
  userId: string,
): Promise<CredentialBundle | null> {
  const row = await prisma.connectorCredential.findUnique({
    where: { orgId_provider_userId: { orgId, provider, userId } },
    select: { secretEnc: true },
  });
  if (!row) return null;

  const parsed: unknown = JSON.parse(openSecret(row.secretEnc));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `connector credential for provider="${provider}" decoded to a non-object bundle`,
    );
  }
  return parsed as CredentialBundle;
}

/**
 * Seal + upsert a connector credential. `sealSecret(JSON.stringify(bundle))`
 * produces the at-rest envelope under the active keyring kid; the row is upserted
 * on the (orgId, provider, userId) unique key so re-connecting refreshes in place.
 *
 * `meta` is OPTIONAL non-secret context (scopes, account email, expiry hints) —
 * NEVER put secret material in `meta`; only the sealed `secretEnc` is protected
 * at rest. We never log the bundle.
 */
export async function setCredential(
  orgId: string,
  provider: string,
  userId: string,
  bundle: CredentialBundle,
  meta?: Prisma.InputJsonValue,
): Promise<void> {
  const secretEnc = sealSecret(JSON.stringify(bundle));
  const metaValue: Prisma.InputJsonValue = meta ?? {};
  await prisma.connectorCredential.upsert({
    where: { orgId_provider_userId: { orgId, provider, userId } },
    create: { orgId, provider, userId, secretEnc, meta: metaValue },
    update: { secretEnc, meta: metaValue },
  });
}
