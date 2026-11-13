import { prisma } from "@/lib/db/client";
import { ipMatchesAny } from "./cidr";
import { trustedClientIp } from "./client-ip";

/**
 * Whether the org's IP allowlist lets this request in: true when the allowlist
 * is off or has no ranges (an empty list never blocks: the anti-lockout rule),
 * otherwise only when the client's trusted address (client-ip.ts) falls in one
 * of its ranges.
 *
 * Both ways in apply it: a session (getAuthContext) and an API key, wherever
 * the key is verified (verifyApiKeyHeader, which getAuthContext and resolveAuth
 * both call). An org that limits access to its own network would not expect a
 * key minted inside that network to work from anywhere.
 *
 * `enabled` is the org's switch when the caller has already read it.
 */
export async function ipAllowlistAdmits(orgId: string, requestHeaders: Headers, enabled?: boolean): Promise<boolean> {
  const on =
    enabled ??
    (await prisma.orgSecuritySettings.findUnique({ where: { orgId }, select: { ipAllowlistEnabled: true } }))
      ?.ipAllowlistEnabled ??
    false;
  if (!on) return true;
  const rules = await prisma.ipAllowlist.findMany({ where: { orgId }, select: { cidr: true } });
  return admitsAddress(trustedClientIp(requestHeaders), { enabled: true, cidrs: rules.map((r) => r.cidr) });
}

/** An org's allowlist: whether it is on, and its ranges. */
export interface AllowlistState {
  enabled: boolean;
  cidrs: string[];
}

/** Whether an allowlist in this state lets this address in (null: an address Cosmos couldn't read). */
export function admitsAddress(ip: string | null, state: AllowlistState): boolean {
  if (!state.enabled || state.cidrs.length === 0) return true;
  return !!ip && ipMatchesAny(ip, state.cidrs);
}

/**
 * The org's security settings as the settings screen shows them, with the
 * address the IP allowlist judges this caller by (null: Cosmos can't read it).
 * Both GET /security/settings and the security page's server prefetch return
 * this, so the screen shows the same address whichever answered first.
 */
export async function securitySettingsFor(orgId: string, requestHeaders: Headers) {
  const settings = await prisma.orgSecuritySettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
  return { ...settings, clientIp: trustedClientIp(requestHeaders) };
}

/** The org's allowlist as it stands. */
export async function allowlistState(orgId: string): Promise<AllowlistState> {
  const [settings, rules] = await Promise.all([
    prisma.orgSecuritySettings.findUnique({ where: { orgId }, select: { ipAllowlistEnabled: true } }),
    prisma.ipAllowlist.findMany({ where: { orgId }, select: { cidr: true } }),
  ]);
  return { enabled: settings?.ipAllowlistEnabled ?? false, cidrs: rules.map((r) => r.cidr) };
}

/**
 * Why a change to the allowlist must be refused, or null. A change is refused
 * when it would shut out the person making it: they are let in now and would
 * not be after. Every change goes through this (adding, relabelling and
 * removing an entry, and turning the allowlist on), so no route can forget it.
 * Someone already outside the list (an internal admin repairing an org) is not
 * stopped from fixing it.
 */
export function lockoutRefusal(requestHeaders: Headers, before: AllowlistState, after: AllowlistState): string | null {
  const ip = trustedClientIp(requestHeaders);
  if (!admitsAddress(ip, before) || admitsAddress(ip, after)) return null;
  if (!ip) {
    return "This would block your own address: Cosmos can't read it from this request, so no range can match it. "
      + "Ask whoever runs Cosmos to set TRUSTED_CLIENT_IP_HEADER.";
  }
  return `This would block your own address (Cosmos sees you as ${ip}). Add it first.`;
}

/** The 409 for `lockoutRefusal`, shaped like the API's other errors (`{ error }`). */
export function lockoutResponse(message: string): Response {
  return Response.json({ error: message }, { status: 409 });
}
