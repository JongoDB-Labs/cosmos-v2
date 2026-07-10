// Feedback status ↔ work-item lifecycle sync. Triage delivers a feedback item as
// a work item and stamps it PLANNED — but the feedback's status must then FOLLOW
// the work item through the board (in-progress → review → done), or reporters
// watch their shipped requests sit at "Planned" forever (observed in prod: 17
// feedback items whose work items were DONE still said PLANNED). One shared
// mapping, applied by every column-writing path: the single-item PUT, the bulk
// route, the assistant executor, and Foreman's moveColumn.
import { prisma as defaultPrisma } from "@/lib/db/client";

/** The subset of the Prisma client this sync needs — accepts the root client, an
 *  interactive-transaction client, or Foreman's own instance. */
export interface StatusSyncClient {
  workItem: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; columnKey: true };
    }): Promise<{ id: string; columnKey: string }[]>;
  };
  feedbackItem: {
    updateMany(args: {
      where: {
        workItemId: { in: string[] };
        status: { notIn: ("DECLINED" | "DONE" | "IN_PROGRESS" | "PLANNED" | "OPEN")[] };
      };
      data: { status: "PLANNED" | "IN_PROGRESS" | "DONE" };
    }): Promise<{ count: number }>;
  };
}

/** Map a board column to the status a feedback reporter should see. `null` =
 *  no opinion (an unknown/custom column never touches feedback). Matches the
 *  same done-detection heuristics the cycle-complete report uses, so "Done",
 *  "Completed ✅", "closed-wont-fix" style custom columns all resolve sanely. */
export function feedbackStatusForColumn(columnKey: string): "PLANNED" | "IN_PROGRESS" | "DONE" | null {
  const k = columnKey.toLowerCase();
  if (["done", "completed", "closed", "shipped"].some((w) => k.includes(w))) return "DONE";
  if (["progress", "doing", "review", "testing", "building"].some((w) => k.includes(w))) return "IN_PROGRESS";
  if (["backlog", "todo", "to-do", "new", "triage"].some((w) => k.includes(w))) return "PLANNED";
  return null;
}

/** Best-effort: reflect the CURRENT column of each work item onto its linked
 *  feedback item(s). Reads the items' columns itself so callers just pass ids
 *  after any write. NEVER throws — a feedback-sync hiccup must not fail the
 *  work-item write it rides on. DECLINED is a human decision and is never
 *  overwritten; rows already at the target status are skipped by the notIn. */
export async function syncFeedbackForWorkItems(
  workItemIds: string[],
  client: StatusSyncClient = defaultPrisma as unknown as StatusSyncClient,
): Promise<void> {
  if (workItemIds.length === 0) return;
  try {
    const items = await client.workItem.findMany({
      where: { id: { in: workItemIds } },
      select: { id: true, columnKey: true },
    });
    // Group by target status so each status is one updateMany.
    const byStatus = new Map<"PLANNED" | "IN_PROGRESS" | "DONE", string[]>();
    for (const it of items) {
      const status = feedbackStatusForColumn(it.columnKey);
      if (!status) continue;
      byStatus.set(status, [...(byStatus.get(status) ?? []), it.id]);
    }
    for (const [status, ids] of byStatus) {
      await client.feedbackItem.updateMany({
        // notIn excludes DECLINED (human decision) and the target itself (no-op
        // writes would still bump updated_at and churn the audit surface).
        where: { workItemId: { in: ids }, status: { notIn: ["DECLINED", status] } },
        data: { status },
      });
    }
  } catch {
    /* best-effort by contract */
  }
}
