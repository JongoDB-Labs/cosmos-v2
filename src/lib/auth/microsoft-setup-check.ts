import { getProviderConfig } from "@/lib/auth/provider-config";
import { microsoftTenant, microsoftTrustedDomains } from "@/lib/auth/microsoft";
import type { FirstPartyRefusal } from "@/lib/auth/first-party-identity";

/** What the callback refuses a first sign-in with when nothing could vouch for
 *  its address, and logs as `sign-in refused: <reason>`. */
const SETUP_INCOMPLETE: FirstPartyRefusal = "ms_setup_incomplete";

/**
 * What an operator should hear at server start about Microsoft sign-in, as plain
 * lines. Pure, so the wording and the conditions are tested.
 *
 * Microsoft decides which address an existing account links by on its first
 * Microsoft sign-in (lib/auth/microsoft verifiedMicrosoftEmails): the `email`
 * claim with `xms_edov`, or a member's sign-in name on a trusted domain (saved
 * in Sign-in providers, or MICROSOFT_TRUSTED_DOMAINS). Without either, a first
 * sign-in is refused with
 * ms_setup_incomplete. Whether tokens carry `xms_edov` is set in the Entra app
 * registration, which this server can't see, so with no trusted domains the line
 * says what that rests on and asks for a change only if sign-ins show it missing.
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
      `No trusted email domains are set (Admin → Sign-in providers, or MICROSOFT_TRUSTED_DOMAINS), so a first Microsoft sign-in can find or create an account only when Microsoft vouches for its email address through the xms_edov optional claim. This server can't see whether the app registration sends that claim. If sign-ins are refused with ${SETUP_INCOMPLETE}, add your organization's email domains in Admin → Sign-in providers, or the email and xms_edov optional claims to the app registration's ID token.`,
    );
  }
  return out;
}

/** Log the warnings once at server start. Never throws. */
export async function warnMicrosoftSetup(): Promise<void> {
  try {
    const cfg = await getProviderConfig("microsoft");
    for (const line of microsoftSetupWarnings(cfg, microsoftTrustedDomains(cfg?.trustedDomains))) {
      console.warn(`[auth:microsoft] ${line}`);
    }
  } catch (err) {
    console.warn("[auth:microsoft] could not check the Microsoft sign-in setup:", err instanceof Error ? err.message : err);
  }
}
