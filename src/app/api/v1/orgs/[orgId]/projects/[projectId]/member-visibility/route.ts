import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { orgContext } from "@/lib/openapi/org-context";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { handleApiError } from "@/lib/api-helpers";
import { memberCanReadInProject, requireProjectRead } from "@/lib/rbac/require-project-read";
import { listProjectMemberVisibility } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/** Members asked about at once: each is a few queries, so not all of a big org together. */
const AT_ONCE = 8;

/**
 * Which of the org's members can see this project's work items, so the
 * assignee picker can mark the ones who can't: an assignment reaches nobody
 * who can't read the item (createNotification), and they couldn't open it.
 * Each member is judged as themselves, by the rule the notification uses
 * (memberCanReadInProject), so the picker and the bell can't disagree.
 *
 * Only for a caller who may change work items in the project, the gate an
 * assignment itself passes, and only a yes or no for each current member,
 * who are the people the picker already lists. A project the caller can't
 * see is refused like a missing one.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listProjectMemberVisibility);
    const { params: p } = await parseRequest(listProjectMemberVisibility, request, params);
    await requireProjectRead(ctx, p.projectId, "ITEM_UPDATE");

    const members = await prisma.orgMember.findMany({ where: { orgId: p.orgId }, select: { userId: true }, orderBy: { joinedAt: "asc" } });
    const rows: { userId: string; canSee: boolean }[] = [];
    for (let i = 0; i < members.length; i += AT_ONCE) {
      const batch = members.slice(i, i + AT_ONCE);
      rows.push(
        ...(await Promise.all(
          batch.map(async ({ userId }) => ({ userId, canSee: await memberCanReadInProject(p.orgId, userId, p.projectId, "ITEM_READ") })),
        )),
      );
    }
    return respond(listProjectMemberVisibility, 200, rows);
  } catch (error) {
    return handleApiError(error);
  }
}
