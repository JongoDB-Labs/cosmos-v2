import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import { sealSecret, openSecret } from "@/lib/crypto/vault";

/**
 * Connector credential accessor — the connector layer's single, org-scoped,
 * vault-sealed credential path (SC-28 / 800-171 3.13.16 protect-at-rest; IA-5;
 * 3.5.10 store only cryptographically-protected secrets).
 *
 * External connector credentials (Google OAuth refresh tokens; GitHub PATs; API
 * keys / access tokens for future providers) live in the `connector_credentials`
 * table as AES-256-GCM vault envelopes (`v2.<kid>.<iv>.<tag>.<ct>`) sealed via
 * `src/lib/crypto/vault.ts` — the SAME rotatable keyring that seals OIDC client
 * secrets, so `scripts/dsop/rotate-vault-key.mjs` re-wraps connector creds too.
 *
 * ── Two credential shapes (see prisma/schema.prisma ConnectorCredential) ──
 *   - PER-USER  (userId NOT NULL): the user's OWN grant — e.g. a personal Google
 *     OAuth refresh token. Read via {@link getCredential} (strict org+user) or
 *     {@link getUserCredential} (the user's grant across any of their orgs).
 *     Written via {@link setCredential}.
 *   - ORG-LEVEL (userId NULL): an org-SHARED credential — e.g. a GitHub PAT or a
 *     Nango/DocuSign service cred — owned by the org, used by the org's agents.
 *     STRICTLY org-scoped (never read cross-org). Read via {@link getOrgCredential},
 *     written via {@link setOrgCredential}.
 *
 * Uniqueness is enforced by TWO PARTIAL unique indexes (migration
 * 20260606090000): `UNIQUE(org,provider,user_id) WHERE user_id IS NOT NULL` and
 * `UNIQUE(org,provider) WHERE user_id IS NULL`. Prisma cannot model a partial
 * unique index, so the write paths below DON'T use `upsert` on a generated
 * compound key — they findFirst-then-update-or-create, which honors the partial
 * indexes (the DB still rejects a true duplicate via the unique constraint).
 *
 * INVARIANTS (gov / no-CUI-or-secret-leak):
 *   - The plaintext secret bundle is sealed BEFORE it touches the DB and opened
 *     ONLY here, server-side, at call time. It is NEVER returned to a client or
 *     the model — callers receive the bundle and use it to mint a provider client.
 *   - We NEVER log the bundle or the sealed `secret_enc`.
 *   - Access is per (org, provider, user[-or-org-level]). Callers MUST pass the
 *     caller's org — this layer does not widen scope.
 *
 * The sealed bundle is a flat string→string map (e.g. `{ refreshToken }`,
 * `{ token }`, `{ accessToken, refreshToken }`). `meta` is NON-secret hints
 * (scopes, account email, expiry) safe to persist unsealed.
 */

/** The decrypted secret bundle — a flat map of secret values (never logged/returned to clients). */
export type CredentialBundle = Record<string, string>;

/** Open a stored vault envelope back to its bundle, validating it decodes to a flat object. */
function openBundle(secretEnc: string, provider: string): CredentialBundle {
  const parsed: unknown = JSON.parse(openSecret(secretEnc));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `connector credential for provider="${provider}" decoded to a non-object bundle`,
    );
  }
  return parsed as CredentialBundle;
}

/**
 * Read + unseal a PER-USER connector credential for the exact (orgId, provider,
 * userId), or `null` when no row exists.
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
  // The per-user partial unique index guarantees at most one matching row; we use
  // findFirst (not findUnique) because the partial unique key isn't Prisma-modeled.
  const row = await prisma.connectorCredential.findFirst({
    where: { orgId, provider, userId },
    select: { secretEnc: true },
  });
  if (!row) return null;
  return openBundle(row.secretEnc, provider);
}

/**
 * Read + unseal a USER-SCOPED connector credential by (provider, userId), regardless
 * of which org row it is stored under. Use this ONLY for providers whose credential is
 * the USER'S OWN resource and is therefore valid across every org the user belongs to —
 * e.g. a personal Google OAuth grant (the same refresh token works whether the user is
 * acting in their primary org or any other). Org-OWNED shared credentials (GitHub PAT /
 * DocuSign / Nango service creds) must use the strictly org-scoped {@link getOrgCredential}
 * (or {@link getCredential}) instead — do NOT use this for those, or you would read one
 * org's credential while acting in another (a cross-tenant leak). The row is stored under
 * the user's primary org (see the write path); this lookup just doesn't re-narrow by the
 * CURRENT org on read, so the user's Google tools keep working in their non-primary orgs
 * (which strict org-scoping would otherwise break — a regression vs the prior user-level
 * token).
 *
 * Returns the most-recently-updated matching bundle, or `null` when none exists.
 */
export async function getUserCredential(
  provider: string,
  userId: string,
): Promise<CredentialBundle | null> {
  const row = await prisma.connectorCredential.findFirst({
    where: { provider, userId },
    orderBy: { updatedAt: "desc" },
    select: { secretEnc: true },
  });
  if (!row) return null;
  return openBundle(row.secretEnc, provider);
}

/**
 * Cheap PRESENCE check for a USER-SCOPED connector credential by (provider, userId),
 * across any of the user's orgs — WITHOUT opening (decrypting) the sealed secret.
 *
 * Use this for a "connected?" status check (e.g. the Google-connected indicator)
 * where the plaintext is not needed — it never touches the vault, so it can't throw
 * an integrity error and never risks logging/handling secret material. Mirrors the
 * user-scoped read semantics of {@link getUserCredential}.
 */
export async function hasUserCredential(
  provider: string,
  userId: string,
): Promise<boolean> {
  const row = await prisma.connectorCredential.findFirst({
    where: { provider, userId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Read + unseal an ORG-LEVEL (userId-null) connector credential for (orgId,
 * provider), or `null` when no row exists. STRICTLY org-scoped — there is no
 * cross-org fallback. Use for org-SHARED service credentials (GitHub PAT first).
 */
export async function getOrgCredential(
  orgId: string,
  provider: string,
): Promise<CredentialBundle | null> {
  // The org-level partial unique index guarantees at most one matching row.
  const row = await prisma.connectorCredential.findFirst({
    where: { orgId, provider, userId: null },
    select: { secretEnc: true },
  });
  if (!row) return null;
  return openBundle(row.secretEnc, provider);
}

/**
 * Seal + write a PER-USER connector credential. `sealSecret(JSON.stringify(bundle))`
 * produces the at-rest envelope under the active keyring kid. Implemented as
 * findFirst-then-update-or-create (the per-user partial unique index isn't a
 * Prisma-modeled key, so `upsert` on a generated compound key is unavailable) so
 * re-connecting refreshes the existing row in place.
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
  const existing = await prisma.connectorCredential.findFirst({
    where: { orgId, provider, userId },
    select: { id: true },
  });
  if (existing) {
    await prisma.connectorCredential.update({
      where: { id: existing.id },
      data: { secretEnc, meta: metaValue },
    });
  } else {
    await prisma.connectorCredential.create({
      data: { orgId, provider, userId, secretEnc, meta: metaValue },
    });
  }
}

/**
 * Seal + write an ORG-LEVEL (userId-null) connector credential. Same seal-at-rest
 * contract as {@link setCredential}, but the row's `userId` is NULL so it is the
 * single org-SHARED credential for (orgId, provider) — enforced by the org-level
 * partial unique index.
 *
 * Implemented as findFirst-then-update-or-create: Prisma `upsert` cannot target a
 * partial-unique-with-NULL compound key (there is no generated unique accessor for
 * `WHERE user_id IS NULL`), so we look up the existing org-level row first. Two
 * such rows can never exist (the partial unique index forbids it), so findFirst is
 * deterministic. Concurrent installs of the same provider would race; the unique
 * index is the backstop (the DB rejects the second insert) — acceptable for an
 * admin-driven install/update path.
 */
export async function setOrgCredential(
  orgId: string,
  provider: string,
  bundle: CredentialBundle,
  meta?: Prisma.InputJsonValue,
): Promise<void> {
  const secretEnc = sealSecret(JSON.stringify(bundle));
  const metaValue: Prisma.InputJsonValue = meta ?? {};
  const existing = await prisma.connectorCredential.findFirst({
    where: { orgId, provider, userId: null },
    select: { id: true },
  });
  if (existing) {
    await prisma.connectorCredential.update({
      where: { id: existing.id },
      data: { secretEnc, meta: metaValue },
    });
  } else {
    await prisma.connectorCredential.create({
      data: { orgId, provider, userId: null, secretEnc, meta: metaValue },
    });
  }
}

/**
 * Delete the ORG-LEVEL (userId-null) connector credential for (orgId, provider),
 * if any. Idempotent. Called on integration uninstall so the sealed secret does
 * not outlive the integration.
 */
export async function deleteOrgCredential(
  orgId: string,
  provider: string,
): Promise<void> {
  await prisma.connectorCredential.deleteMany({
    where: { orgId, provider, userId: null },
  });
}
