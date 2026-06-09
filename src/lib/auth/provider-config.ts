import { prisma } from "@/lib/db/client";
import { sealSecret, openSecret } from "@/lib/crypto/vault";

/**
 * Instance-level OAuth sign-in provider configuration, stored vault-sealed in
 * `AuthProviderConfig` and managed from the /admin UI — NOT from env vars. The
 * sign-in flow reads this at request time so an admin can rotate creds without
 * a redeploy, and nothing sensitive lives in plaintext.
 */
export type AuthProvider = "microsoft" | "google";

export interface ProviderCreds {
  clientId: string;
  clientSecret: string;
  /** Microsoft only: tenant segment of the authority ("common", a domain, or a
   *  directory id). Ignored for providers that don't use it. */
  tenant?: string | null;
}

export interface ProviderConfig extends ProviderCreds {
  enabled: boolean;
}

/** Read + unseal a provider's config, or null if unset/disabled-shaped/corrupt. */
export async function getProviderConfig(
  provider: AuthProvider,
): Promise<ProviderConfig | null> {
  const row = await prisma.authProviderConfig.findUnique({
    where: { provider },
    select: { enabled: true, secretEnc: true },
  });
  if (!row) return null;
  let bundle: ProviderCreds;
  try {
    bundle = JSON.parse(openSecret(row.secretEnc)) as ProviderCreds;
  } catch {
    return null;
  }
  if (!bundle.clientId || !bundle.clientSecret) return null;
  return {
    enabled: row.enabled,
    clientId: bundle.clientId,
    clientSecret: bundle.clientSecret,
    tenant: bundle.tenant ?? null,
  };
}

/** A provider is usable by the sign-in flow iff it has creds AND is enabled. */
export async function isProviderEnabled(provider: AuthProvider): Promise<boolean> {
  const cfg = await getProviderConfig(provider);
  return cfg != null && cfg.enabled;
}

/** Seal + upsert a provider's creds. Empty clientSecret PRESERVES the existing
 *  one (so an admin can toggle enabled / change clientId without re-typing the
 *  secret) — mirrors the connector-credential "blank means unchanged" rule. */
export async function setProviderConfig(
  provider: AuthProvider,
  input: { clientId: string; clientSecret?: string; tenant?: string | null; enabled?: boolean },
  updatedBy?: string,
): Promise<void> {
  const existing = await getProviderConfig(provider);
  const clientSecret =
    input.clientSecret && input.clientSecret.trim().length > 0
      ? input.clientSecret.trim()
      : existing?.clientSecret;
  if (!clientSecret) {
    throw new Error("A client secret is required the first time you configure this provider.");
  }
  const secretEnc = sealSecret(
    JSON.stringify({
      clientId: input.clientId.trim(),
      clientSecret,
      tenant: input.tenant?.trim() || null,
    }),
  );
  await prisma.authProviderConfig.upsert({
    where: { provider },
    update: { secretEnc, enabled: input.enabled ?? true, updatedBy: updatedBy ?? null },
    create: { provider, secretEnc, enabled: input.enabled ?? true, updatedBy: updatedBy ?? null },
  });
}

/** Non-secret status for the admin UI / login probe. */
export async function getProviderStatus(
  provider: AuthProvider,
): Promise<{ configured: boolean; enabled: boolean }> {
  const row = await prisma.authProviderConfig.findUnique({
    where: { provider },
    select: { enabled: true, secretEnc: true },
  });
  return { configured: row != null, enabled: row?.enabled ?? false };
}
