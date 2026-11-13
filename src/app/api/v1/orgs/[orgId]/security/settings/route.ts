import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext, revokeOrgSessions } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { deleteApiKeysIn, keyHoldersWithoutManage } from "@/lib/auth/api-key-manage.server";
import { z } from "zod";
import { AccountRequestMode, type Prisma } from "@prisma/client";
import { allowlistState, lockoutRefusal, lockoutResponse, securitySettingsFor } from "@/lib/auth/ip-allowlist";
import { parseActionRestrictions } from "@/lib/security/action-restrictions";

/** Minutes, where 0 turns the setting off and anything else is at least `min`. */
const minutesOrOff = (min: number, max: number, what: string) =>
  z
    .number()
    .int()
    .refine((v) => v === 0 || (v >= min && v <= max), `${what}: 0 (off) or ${min} to ${max}`);

const updateSettingsSchema = z.object({
  mfaRequired: z.boolean().optional(),
  sessionTimeoutMins: z.number().int().min(5).max(43200).optional(),
  ipAllowlistEnabled: z.boolean().optional(),
  scimEnabled: z.boolean().optional(),
  ssoEnforced: z.boolean().optional(),
  ssoConnectionId: z.string().nullable().optional(),
  allowedDomains: z.array(z.string()).optional(),
  auditRetentionDays: z.number().int().min(30).max(3650).optional(),
  // Whether outsiders may ask this org for an account, and who may ask.
  // OFF is the default everywhere; see the AccountRequest model.
  accountRequestMode: z.nativeEnum(AccountRequestMode).optional(),
  // Session caps, enforced in getAuthContext. 0 turns each off.
  maxSessionAgeMins: minutesOrOff(15, 525_600, "Maximum session age").optional(),
  idleTimeoutMins: minutesOrOff(5, 43_200, "Idle timeout").optional(),
  maxConcurrentSessions: z
    .number()
    .int()
    .min(0, "Sessions per person: 0 (no limit) or more")
    .max(100)
    .optional(),
  // Org-wide deny rules. Checked strictly below, not here, so a refusal can
  // name the rule it is about.
  actionRestrictions: z.unknown().optional(),
  // "Members can create their own API keys". Off also stops the keys members
  // already made from authenticating (src/lib/auth/api-key-policy.ts).
  memberApiKeysEnabled: z.boolean().optional(),
});

/**
 * AU-11 gov retention floor: GOV-class tenants must retain audit logs for at least
 * 3 years (1095 days). We coerce up rather than reject so the floor can't be lowered.
 * Commercial tenants keep the schema's 30–3650 range. Returns the (possibly clamped)
 * value; `undefined` in → `undefined` out (no change requested).
 */
export const GOV_AUDIT_RETENTION_FLOOR_DAYS = 1095;

export function clampGovRetentionDays(
  tenantClass: string,
  auditRetentionDays: number | undefined,
): number | undefined {
  if (auditRetentionDays === undefined) return undefined;
  if (tenantClass === "GOV" && auditRetentionDays < GOV_AUDIT_RETENTION_FLOOR_DAYS) {
    return GOV_AUDIT_RETENTION_FLOOR_DAYS;
  }
  return auditRetentionDays;
}

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SECURITY_MANAGE);

    // With the address the IP allowlist will judge this person by, so the
    // settings screen can say what to add before turning it on.
    return success(await securitySettingsFor(orgId, request.headers));
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * True when a settings state would claim to restrict account requests while
 * accepting every address. An empty allowed-domains list means "unrestricted"
 * everywhere else (see allowed-domains.ts), so ALLOWLIST with no domains is
 * the stricter-looking setting behaving as the weaker one.
 *
 * Takes EFFECTIVE values, not just the ones a request sets. Reading only an
 * incoming mode was fail-open on drift: an org already on ALLOWLIST could
 * clear its domains without naming the mode and land in exactly this state.
 */
export function allowlistWithoutDomains(
  mode: AccountRequestMode | undefined,
  domains: string[],
): boolean {
  if (mode !== AccountRequestMode.ALLOWLIST) return false;
  return domains.map((d) => d.trim()).filter(Boolean).length === 0;
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SECURITY_MANAGE);

    const body = await request.json();
    const { actionRestrictions: rawRestrictions, ...data } = updateSettingsSchema.parse(body);

    let actionRestrictions: Prisma.InputJsonValue | undefined;
    if (rawRestrictions !== undefined) {
      const parsed = parseActionRestrictions(rawRestrictions);
      if (!parsed.ok) {
        return new Response(
          JSON.stringify({ error: parsed.error, ruleIndex: parsed.ruleIndex }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      actionRestrictions = parsed.rules as unknown as Prisma.InputJsonValue;
    }

    // AU-11: enforce the gov retention floor (>=3yr) for GOV-class tenants.
    data.auditRetentionDays = clampGovRetentionDays(org.tenantClass, data.auditRetentionDays);

    // Snapshot the prior posture so we can detect a *tightening* below (false→true).
    const prior = await prisma.orgSecuritySettings.findUnique({
      where: { orgId },
      select: { ssoEnforced: true, mfaRequired: true, allowedDomains: true, accountRequestMode: true },
    });

    // ALLOWLIST with no domains configured is NOT a restriction: an empty list
    // means "unrestricted" everywhere else (see allowed-domains.ts), so this
    // combination would quietly behave exactly like OPEN while reading as
    // locked down. Refuse it rather than let the stricter-looking setting be
    // the weaker one. Considers the domains being set in this same request.
    if (
      allowlistWithoutDomains(
        data.accountRequestMode ?? prior?.accountRequestMode,
        data.allowedDomains ?? prior?.allowedDomains ?? [],
      )
    ) {
      return new Response(
        JSON.stringify({
          error:
            "Add at least one allowed email domain before restricting account "
            + "requests to the allowlist — with no domains it would accept every address.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Turning the IP allowlist on must not shut out the person turning it on.
    if (data.ipAllowlistEnabled !== undefined) {
      const before = await allowlistState(orgId);
      const lockout = lockoutRefusal(request.headers, before, { ...before, enabled: data.ipAllowlistEnabled });
      if (lockout) return lockoutResponse(lockout);
    }

    const settings = await prisma.orgSecuritySettings.upsert({
      where: { orgId },
      create: {
        orgId,
        ...data,
        ssoConnectionId: data.ssoConnectionId ?? null,
        ...(actionRestrictions !== undefined && { actionRestrictions }),
      },
      update: {
        ...(data.mfaRequired !== undefined && { mfaRequired: data.mfaRequired }),
        ...(data.sessionTimeoutMins !== undefined && { sessionTimeoutMins: data.sessionTimeoutMins }),
        ...(data.ipAllowlistEnabled !== undefined && { ipAllowlistEnabled: data.ipAllowlistEnabled }),
        ...(data.scimEnabled !== undefined && { scimEnabled: data.scimEnabled }),
        ...(data.ssoEnforced !== undefined && { ssoEnforced: data.ssoEnforced }),
        ...(data.ssoConnectionId !== undefined && { ssoConnectionId: data.ssoConnectionId }),
        ...(data.allowedDomains !== undefined && { allowedDomains: data.allowedDomains }),
        ...(data.auditRetentionDays !== undefined && { auditRetentionDays: data.auditRetentionDays }),
        ...(data.accountRequestMode !== undefined && { accountRequestMode: data.accountRequestMode }),
        ...(data.maxSessionAgeMins !== undefined && { maxSessionAgeMins: data.maxSessionAgeMins }),
        ...(data.idleTimeoutMins !== undefined && { idleTimeoutMins: data.idleTimeoutMins }),
        ...(data.maxConcurrentSessions !== undefined && { maxConcurrentSessions: data.maxConcurrentSessions }),
        ...(actionRestrictions !== undefined && { actionRestrictions }),
        ...(data.memberApiKeysEnabled !== undefined && { memberApiKeysEnabled: data.memberApiKeysEnabled }),
      },
    });

    // What changed, and the new value of each session cap. Restrictions are
    // recorded by count only: the rules themselves are on the settings row.
    const changed = Object.entries(data).filter(([, v]) => v !== undefined).map(([k]) => k);
    if (actionRestrictions !== undefined) changed.push("actionRestrictions");
    const capValues: Record<string, string> = {};
    for (const k of ["maxSessionAgeMins", "idleTimeoutMins", "maxConcurrentSessions"] as const) {
      if (data[k] !== undefined) capValues[k] = String(data[k]);
    }
    const restrictionCount = Array.isArray(actionRestrictions) ? actionRestrictions.length : null;

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "security_settings.updated",
      entity: "org_security_settings",
      entityId: settings.id,
      metadata: {
        changes: changed.join(", "),
        ...capValues,
        ...(restrictionCount !== null && {
          actionRestrictions: `${restrictionCount} rule${restrictionCount === 1 ? "" : "s"}`,
        }),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // When a GOV org TIGHTENS its auth posture (SSO enforced or MFA required,
    // false→true), revoke all existing member sessions so weaker-assurance
    // sessions (Google / pre-enforcement) can't ride past the new floor. Only
    // on the rising edge — re-saving an already-strict policy is a no-op.
    const tightenedSso =
      data.ssoEnforced === true && prior?.ssoEnforced !== true;
    const tightenedMfa =
      data.mfaRequired === true && prior?.mfaRequired !== true;

    // In EVERY org, turning on Require MFA also revokes the API keys of
    // everyone who can't manage keys. The MFA floor binds sessions in every org
    // (orgSessionFloors), and a key has no sign-in to check against it, so a
    // member's key made under the old rules would otherwise outlive the rule
    // for up to a year. Admins' keys stay: they can see and revoke every key
    // themselves. The response says how many went, so the admin who saved
    // knows.
    //
    // `ssoEnforced` revokes no keys: no sign-in path reads it. The single
    // sign-on rule that binds keys is the org's enforced IdP connection
    // (orgRequiresSso), and it is checked each time a key is used, not here:
    // see keyInactiveReason.
    let apiKeysRevoked = 0;
    if (tightenedMfa) {
      const holders = await keyHoldersWithoutManage(orgId);
      if (holders.length > 0) {
        apiKeysRevoked = await prisma.$transaction(async (tx) => {
          const prefixes = await deleteApiKeysIn(tx, { orgId, createdById: { in: holders } });
          if (prefixes.length > 0) {
            await logAudit({
              orgId,
              userId: ctx.userId,
              action: "security_settings.api_keys_revoked",
              entity: "org_security_settings",
              entityId: settings.id,
              metadata: {
                reason: "mfa_required",
                revokedCount: prefixes.length,
                prefixes,
              },
              ipAddress: getIpAddress(request),
            }, tx);
          }
          return prefixes.length;
        });
      }
    }

    if (org.tenantClass === "GOV" && (tightenedSso || tightenedMfa)) {
      const revoked = await revokeOrgSessions(orgId);
      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "security_settings.sessions_revoked",
        entity: "org_security_settings",
        entityId: settings.id,
        metadata: {
          reason: tightenedSso ? "sso_enforced" : "mfa_required",
          revokedCount: String(revoked),
        } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });
    }

    return success({ ...settings, apiKeysRevoked });
  } catch (error) {
    return handleApiError(error);
  }
}
