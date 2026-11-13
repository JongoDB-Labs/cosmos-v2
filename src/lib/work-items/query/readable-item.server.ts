import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { getReadableProjectIds } from "./scope";
import { runWorkItemQuery, type IssueRow } from "./project";

/**
 * One work item, by key ("ACME-12") or id, if `auth` may read it: the item-read
 * bit, then the same readable-project set and query the work-items list uses.
 * Null for anything they can't open. Every message Cosmos sends to a person
 * outside the app (Teams cards, Slack messages) reads the item through this,
 * as its recipient, at send time.
 */
export async function findReadableWorkItem(auth: AuthContext, orgId: string, ref: string): Promise<IssueRow | null> {
  if (!hasPermission(auth.permissions, Permission.ITEM_READ)) return null;
  const readable = await getReadableProjectIds(auth);
  if (!readable.length) return null;
  let id = ref;
  const key = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(ref.trim());
  if (key) {
    // Same rule as the item deep link: a key only within readable projects,
    // and an ambiguous one (two readable projects with that key) not at all.
    const projects = await prisma.project.findMany({
      where: { orgId, id: { in: readable }, key: { equals: key[1], mode: "insensitive" } },
      select: { id: true },
      take: 2,
    });
    if (projects.length !== 1) return null;
    const hit = await prisma.workItem.findFirst({
      where: { orgId, projectId: projects[0].id, ticketNumber: Number(key[2]) },
      select: { id: true },
    });
    if (!hit) return null;
    id = hit.id;
  } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
    return null;
  }
  const r = await runWorkItemQuery({ orgId, allowedProjectIds: readable, filter: { ids: [id] }, sort: undefined, page: 1, pageSize: 1 });
  return r.data[0] ?? null;
}
