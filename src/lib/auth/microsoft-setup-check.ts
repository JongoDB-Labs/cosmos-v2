import { getProviderConfig } from "@/lib/auth/provider-config";
import { microsoftTenant, microsoftTrustedDomains } from "@/lib/auth/microsoft";

/**
 * What an operator should hear at server start about Microsoft sign-in, as plain
 * lines. Pure, so the wording and the conditions are tested.
 *
 * Microsoft decides which address an existing account links by on its first
 * Microsoft sign-in (lib/auth/microsoft verifiedMicrosoftEmails): the `email`
 * claim with `xms_edov`, or a member's sign-in name on a domain in
 * MICROSOFT_TRUSTED_DOMAINS. Without either, existing people can't link.
 */
export function microsoftSetupWarnings(
  cfg: { enabled: boolean; tenant?: string | null } | null,
  trustedDomains: string[],
): string[] {
  if (!cfg?.enabled) return [];
  const t = microsoftTenant(cfg.tenant).toLowerCase();
  const out: string[] = [];
  if (t === "common" || t === "organizations") {
    out.push(
      "Microsoft sign-in accepts accounts from any Microsoft tenant. A deployment for one organization should set its tenant in Sign-in providers.",
    );
  }
  if (trustedDomains.length === 0) {
    out.push(
      "Existing accounts link on their first Microsoft sign-in only when the ID token carries the xms_edov optional claim, or the account's domain is listed in MICROSOFT_TRUSTED_DOMAINS. Add the email and xms_edov optional claims to the app registration, or set MICROSOFT_TRUSTED_DOMAINS.",
    );
  }
  return out;
}

/** Log the warnings once at server start. Never throws. */
export async function warnMicrosoftSetup(): Promise<void> {
  try {
    const cfg = await getProviderConfig("microsoft");
    for (const line of microsoftSetupWarnings(cfg, microsoftTrustedDomains())) {
      console.warn(`[auth:microsoft] ${line}`);
    }
  } catch (err) {
    console.warn("[auth:microsoft] could not check the Microsoft sign-in setup:", err instanceof Error ? err.message : err);
  }
}
