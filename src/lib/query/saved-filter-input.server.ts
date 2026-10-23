/** Small shared checks for the saved-filter routes. */
import { prisma } from "@/lib/db/client";

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
