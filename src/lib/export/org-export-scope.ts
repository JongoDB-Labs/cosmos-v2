import type { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission, maskFromDb, permissionNames, type PermissionKey } from "@/lib/rbac/permissions";
import { ProblemError } from "@/lib/openapi/problem";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { moneyGate, projectMoneyEach } from "@/lib/rbac/money-fields";
import { redactRates } from "@/lib/time/visibility";
import { logAudit } from "@/lib/audit";

/**
 * What the org export (CSV per entity, and the JSON archive) may hand out.
 *
 * ORG_EXPORT says "may take data out of the product". It does not say which
 * data, and a work role can grant it to someone with no finance access. So the
 * export answers each entity, and each record, the way the screen for it would:
 *
 *  - Each entity: the bit its own list asks for (`EXPORT_ENTITY_READ`), or it
 *    is left out of the archive and its CSV is refused.
 *  - Work items and sprints: from the projects their lists read them from.
 *  - Meetings: the meeting list's rule (`readableMeetingsWhere`).
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

/**
 * The bit each entity's own list asks for, so the bit its export asks for. One
 * table for both doors: the JSON archive leaves out an entity the exporter may
 * not read, and the CSV for it is refused, as revenues and expenses always were
 * without finance. Left out, never an empty list: that reads as "this org has
 * none".
 *
 * ORG_EXPORT comes with ADMIN and up, who hold all of these. The table is for
 * everyone else: a work role granting export to someone with less, or a work
 * role restriction taking a module away from an admin. CRM data and meetings
 * used to go to any exporter.
 *
 * Time entries ask TIME_READ for the module, but their rows stay org-wide, with
 * rates redacted (`exportableTime`): that was decided when the export was scoped.
 */
export const EXPORT_ENTITY_READ = {
  projects: "PROJECT_READ", // GET /projects
  workItems: "ITEM_READ", // GET /work-items
  intervals: "SPRINT_READ", // GET /projects/:id/intervals
  crmContacts: "CRM_READ", // GET /crm/contacts
  partners: "CRM_READ", // GET /partners
  products: "CRM_READ", // GET /products
  contracts: "CRM_READ", // GET /contracts
  notes: "NOTE_READ", // GET /notes
  meetings: "MEETING_READ", // GET /meetings
  timeEntries: "TIME_READ", // GET /time-entries
  revenues: "FINANCE_READ", // GET /finance/revenue
  expenses: "FINANCE_READ", // GET /finance/expenses
} as const satisfies Record<string, PermissionKey>;

export type ExportEntity = keyof typeof EXPORT_ENTITY_READ;

/** May this exporter take this entity out at all? Its list's bit (`EXPORT_ENTITY_READ`). */
export function mayExportEntity(ctx: AuthContext, entity: ExportEntity): boolean {
  return hasPermission(ctx.permissions, Permission[EXPORT_ENTITY_READ[entity]]);
}

/** Revenues and expenses: the same bit their own lists require. */
export function mayExportFinance(ctx: AuthContext): boolean {
  return mayExportEntity(ctx, "revenues") && mayExportEntity(ctx, "expenses");
}

/**
 * Work items and sprints come from the projects their lists read them from:
 * the shared project-read rule asked about the entity's own action, so a key's
 * project scope, a team-scoped project's team and a policy denying that action
 * on a project all keep its rows out. Not visibility alone, which is all this
 * used to ask.
 */
export async function exportableProjectRowsWhere(
  ctx: AuthContext,
  entity: "workItems" | "intervals",
): Promise<{ projectId: { in: string[] } }> {
  return { projectId: { in: await getReadableProjectIds(ctx, EXPORT_ENTITY_READ[entity]) } };
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
