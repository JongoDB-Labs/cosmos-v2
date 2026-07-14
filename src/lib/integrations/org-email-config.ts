import { prisma } from "@/lib/db/client";
import { openSecret } from "@/lib/crypto/vault";

/**
 * Per-org transactional-email (Resend) config resolution.
 *
 * The org's provider API key is SEALED with the cosmos vault (AES-256-GCM keyring,
 * `{ sealed: <ciphertext> }` in the `OrgEmailSettings.apiKey` Json column) and is
 * unsealed ONLY here, server-side, at send time — mirroring how the org's Claude
 * connection resolves its sealed token (see src/lib/ai/ai-credentials.ts). The key
 * is never logged and never leaves this process except in the outbound Resend
 * Authorization header built by the sender.
 *
 * Resolution TOLERATES failure by returning null (a DB hiccup, a disabled row, an
 * incomplete config, or a corrupt/rotated/tampered sealed key all degrade to null),
 * so a broken per-org credential can never crash a send — the sender then falls
 * back to env RESEND_API_KEY/EMAIL_FROM, and finally to the inviter's Gmail.
 */

export interface OrgEmailConfig {
  apiKey: string;
  from: string;
  provider: string;
}

/** The `{ sealed }` Json shape the API-key column is persisted in. */
function isSealedRecord(value: unknown): value is { sealed: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "sealed" in value &&
    typeof (value as { sealed: unknown }).sealed === "string"
  );
}

/**
 * Does this Json value hold a sealed API key? A STATUS-only check (never unseals),
 * used by the GET route to report `configured` without touching the plaintext key.
 */
export function hasSealedApiKey(value: unknown): boolean {
  return isSealedRecord(value);
}

/** Open a `{ sealed }` Json value to plaintext, or null on absence/tamper. */
function unsealApiKey(value: unknown): string | null {
  if (isSealedRecord(value)) {
    try {
      return openSecret(value.sealed);
    } catch {
      return null; // corrupt / rotated / tampered → degrade, never throw
    }
  }
  return null;
}

/**
 * Resolve the org's transactional-email config, or null when it isn't usable.
 * Returns the unsealed config ONLY when the row is `enabled`, the sealed `apiKey`
 * opens successfully, AND a `fromAddress` is set; otherwise null.
 */
export async function getOrgEmailConfig(
  orgId: string,
): Promise<OrgEmailConfig | null> {
  let settings: {
    provider: string;
    apiKey: unknown;
    fromAddress: string | null;
    enabled: boolean;
  } | null;
  try {
    settings = await prisma.orgEmailSettings.findUnique({
      where: { orgId },
      select: { provider: true, apiKey: true, fromAddress: true, enabled: true },
    });
  } catch {
    return null; // a DB hiccup degrades to the env/Gmail fallback — never throws
  }

  if (!settings || !settings.enabled || !settings.fromAddress) return null;

  const apiKey = unsealApiKey(settings.apiKey);
  if (!apiKey) return null;

  return { apiKey, from: settings.fromAddress, provider: settings.provider };
}
