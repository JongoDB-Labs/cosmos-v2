import type { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission, maskFromDb, permissionNames } from "@/lib/rbac/permissions";
import { ProblemError } from "@/lib/openapi/problem";
import { moneyGate, projectMoneyEach } from "@/lib/rbac/money-fields";
import { redactRates } from "@/lib/time/visibility";
import { logAudit } from "@/lib/audit";

/**
 * What the org export (CSV per entity, and the JSON archive) may hand out.
 *
 * ORG_EXPORT says "may take data out of the product". It does not say which
 * data, and a work role can grant it to someone with no finance access. So the
 * export answers each record the way the screen for it would:
 *
 *  - Notes: the exporter's own private notes, and shared ones. Never anyone
 *    else's private note -- the notes list refuses it, and so does this.
 *  - Time: every entry the export already carried, but a rate only on the
 *    exporter's own entries or with FINANCE_READ (`redactRates`).
 *  - Revenues and expenses: FINANCE_READ, as their lists require.
 *  - Contracts: the row, with its money fields left out unless the exporter
 *    may see money on its project (`moneyGate`, shared with the registers).
 *  - Members: the person's profile, never their sign-in record. A password
 *    hash or an MFA secret is not org data, whoever is exporting. Their
 *    permissions as permission names, never the raw mask, and no policy rules.
 *  - The organization: its name and branding. Not the identity-provider or
 *    database link, and its settings only for whoever may change them -- the
 *    same cut the organization's own read route makes.
 *
 * A read that fails fails the export, naming what it could not read. It used
 * to become an empty list, so an archive looked complete and said the org had
 * none of that thing. And every export is audited (`auditExport`).
 */

/** Notes the exporter may take out: their own private ones, and shared ones. */
export function exportableNotesWhere(userId: string): Prisma.NoteWhereInput {
  return {
    OR: [
      { visibility: "PRIVATE", authorId: userId },
      { visibility: { in: ["ORG", "PROJECT"] } },
    ],
  };
}

/** Revenues and expenses: the same bit their own lists require. */
export function mayExportFinance(ctx: AuthContext): boolean {
  return hasPermission(ctx.permissions, Permission.FINANCE_READ);
}

/** Time entries with rates the exporter may not see blanked, as the time screens do. */
export function exportableTime<T extends { userId: string; rate?: unknown }>(ctx: AuthContext, rows: T[]): T[] {
  return redactRates(ctx, rows);
}

/** Contracts, each with its money left out where the exporter may not see it. */
export async function exportableContracts<T extends { projectId: string | null }>(
  ctx: AuthContext,
  rows: T[],
) {
  return projectMoneyEach("vendor", rows, await moneyGate(ctx));
}

/**
 * A member's own columns as the archive carries them. The user row beside them
 * is the JSON route's `EXPORTED_USER`, kept in the route so the guard on routes
 * that send email addresses (member-disclosure.arch.test.ts) sees this one.
 */
export const EXPORT_MEMBER_SELECT = {
  id: true,
  userId: true,
  role: true,
  permissions: true,
  joinedAt: true,
  removedAt: true,
} satisfies Prisma.OrgMemberSelect;

/** The permission mask as permission names: what it grants, not how it is stored. */
export function exportableMember<T extends { permissions: string }>(m: T): Omit<T, "permissions"> & { permissions: string[] } {
  return { ...m, permissions: permissionNames(maskFromDb(m.permissions)) };
}

/**
 * The organization row as the archive carries it. Not `auth0OrgId` (the
 * identity provider's id for the org) nor `dbConnectionId`, which are
 * deployment wiring rather than org data.
 *
 * `settings` holds feature configuration -- query language, calendar feeds,
 * time-off and project-numbering policy, navigation layout, feedback
 * automation, finance markup, the uploaded logo's storage key. The app keeps
 * no credentials there (those are sealed in their own tables), but the
 * organization update accepts arbitrary keys, so it goes only to someone who
 * may change it, as on the organization's own read route.
 */
export const EXPORT_ORG_SELECT = {
  id: true,
  name: true,
  slug: true,
  plan: true,
  tenantClass: true,
  logoUrl: true,
  themePrimary: true,
  themeMode: true,
  defaultSkinId: true,
  brandName: true,
  agentName: true,
  tagline: true,
  wakeWord: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrganizationSelect;

/** May this exporter take the organization's settings? The bit that may change them. */
export function mayExportSettings(ctx: AuthContext): boolean {
  return hasPermission(ctx.permissions, Permission.ORG_UPDATE);
}

/**
 * One entity's rows, or a failure that says which entity. Never an empty list
 * standing in for a read that failed.
 */
export async function exportEntity<T>(entity: string, read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    console.error(`[export] reading ${entity} failed`, error);
    throw new ProblemError(
      500,
      "internal_error",
      `The export stopped because ${entity} could not be read. Nothing was exported. Try again.`,
    );
  }
}

/**
 * The audit row for an export: who took which entities out, and whether the
 * money came with them. Never any of the data itself.
 */
export async function auditExport(
  ctx: AuthContext,
  opts: { format: "json" | "csv"; entities: string[]; ipAddress?: string | null },
): Promise<void> {
  await logAudit({
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "org.data_exported",
    entity: "organization",
    entityId: ctx.orgId,
    metadata: { format: opts.format, entities: opts.entities, includeFinance: mayExportFinance(ctx) },
    ipAddress: opts.ipAddress ?? undefined,
  });
}
