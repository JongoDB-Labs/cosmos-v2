import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { applyWorkItemChange } from "@/lib/work-items/apply-change.server";
import type { BulkDenial } from "@/lib/workflow/contract";
import { mergeEffects, runAfterCommit, type AfterCommitEffects } from "@/lib/work-items/after-commit";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { bulkDeleteWorkItems, bulkUpdateWorkItems } from "./route.contract";
import { publishToOrg } from "@/lib/realtime/broker";

// Bulk ops accept a large selection: "select all N matching" (v2.128.0) spans
// the ENTIRE result set, not just the visible page, so a project with hundreds
// or thousands of items must still delete/edit them in one action. The old
// `.max(100)` cap rejected exactly that selection with a 400 ("Too big"), which
// surfaced to the user as "Couldn't delete the selected items." The cap
// (BULK_MAX, in the contract's body schema) is only a sanity/DoS bound — the
// DB writes below chunk the ids so a large IN list stays cheap and never
// becomes one giant statement.
const BULK_CHUNK = 500;

/** Split ids into fixed-size batches (keeps each deleteMany/updateMany small). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, bulkUpdateWorkItems);
    const { params: { orgId, projectId }, body: { ids, update, transition } } =
      await parseRequest(bulkUpdateWorkItems, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.ITEM_BULK_EDIT);

    // Each batch is one transaction through the same writer as a single edit,
    // so a bulk move stamps dates, clears a cancel reason, records history and
    // keeps the assignee set exactly as dragging each card would. Batches keep
    // each transaction (and its IN lists) small; a later batch failing leaves
    // the earlier ones applied, as before.
    const parts: AfterCommitEffects[] = [];
    const denied: BulkDenial[] = [];
    let updatedCount = 0;
    for (const batch of chunk(ids, BULK_CHUNK)) {
      const change = await prisma.$transaction((tx) =>
        applyWorkItemChange(tx, {
          actorId: ctx.userId,
          orgId,
          projectId,
          itemIds: batch,
          patch: update,
          source: "BULK",
          actor: ctx,
          transition,
        }),
      );
      updatedCount += change.itemIds.length;
      parts.push(change.effects);
      // The workflow refuses items one by one; the rest of the selection still
      // moves, as a bulk transition does in Jira.
      denied.push(
        ...change.denied.map((d) => ({
          id: d.itemId,
          code: d.body.code,
          message: d.body.error,
          // What to ask for, so the selection's details are collected once and sent again.
          ...(d.body.transition && { transition: d.body.transition }),
          ...(d.body.fields && { fields: d.body.fields }),
        })),
      );
    }

    const effects = mergeEffects(parts);
    if (effects) await runAfterCommit(effects, { ipAddress: getIpAddress(request) });

    return respond(bulkUpdateWorkItems, 200, { updated: updatedCount, denied });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, bulkDeleteWorkItems);
    const { params: { orgId, projectId }, body: { ids } } = await parseRequest(bulkDeleteWorkItems, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.ITEM_DELETE);

    let deletedCount = 0;
    for (const batch of chunk(ids, BULK_CHUNK)) {
      const r = await prisma.workItem.deleteMany({
        where: { id: { in: batch }, orgId, projectId },
      });
      deletedCount += r.count;
    }
    const result = { count: deletedCount };

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item.bulk_deleted",
      entity: "work_item",
      metadata: { count: String(result.count) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    publishToOrg(orgId, "work-item.deleted", { ids });
    return respond(bulkDeleteWorkItems, 204, undefined);
  } catch (error) {
    return handleApiError(error, request);
  }
}
