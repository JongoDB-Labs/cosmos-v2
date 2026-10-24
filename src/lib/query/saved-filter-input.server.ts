/** Small shared checks for the saved-filter routes. */
import type { FilterVisibility } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";

/** Custom field key → type, for the legacy-shape translation. */
export async function cfTypesFor(orgId: string): Promise<Map<string, string>> {
  const rows = await prisma.customField.findMany({ where: { orgId }, select: { key: true, fieldType: true } });
  return new Map(rows.map((r) => [r.key, r.fieldType as string]));
}

/** Co-editors must be current members of the org; returns why not, or null. */
export async function editorProblem(orgId: string, editorIds: string[] | undefined): Promise<string | null> {
  if (!editorIds?.length) return null;
  const ids = [...new Set(editorIds)];
  const n = await prisma.orgMember.count({ where: { orgId, userId: { in: ids } } });
  return n === ids.length ? null : "Editors must be members of this organization.";
}

/**
 * A filter shared with a project or team may only be co-edited by people who
 * can read that project: being an editor shows the filter, so an editor who
 * can't read its target would learn of it. Returns why not, or null. Checked
 * against each editor's OWN access (their role, work roles and ABAC policies),
 * not the caller's.
 */
export async function editorAccessProblem(
  orgId: string,
  editorIds: string[],
  target: { visibility: FilterVisibility; projectId?: string | null; teamId?: string | null },
): Promise<string | null> {
  if (editorIds.length === 0) return null;
  let projectId: string | null = null;
  if (target.visibility === "PROJECT") projectId = target.projectId ?? null;
  else if (target.visibility === "TEAM" && target.teamId) {
    projectId = (await prisma.team.findFirst({ where: { id: target.teamId, orgId }, select: { projectId: true } }))?.projectId ?? null;
  }
  if (!projectId) return null;
  const blocked: string[] = [];
  for (const userId of new Set(editorIds)) {
    const ctx = await loadMemberAuthContext(orgId, userId);
    if (!ctx || !(await getReadableProjectIds(ctx)).includes(projectId)) blocked.push(userId);
  }
  if (blocked.length === 0) return null;
  const users = await prisma.user.findMany({ where: { id: { in: blocked } }, select: { displayName: true }, orderBy: { displayName: "asc" } });
  const who = users.map((u) => u.displayName).join(", ") || "An editor";
  return `${who} can't see the ${target.visibility === "TEAM" ? "team's project" : "project"} this filter is shared with, so they can't edit it.`;
}
