// Feedback status ↔ work-item lifecycle sync. Triage delivers a feedback item as
// a work item and stamps it PLANNED — but the feedback's status must then FOLLOW
// the work item through the board (in-progress → review → done), or reporters
// watch their shipped requests sit at "Planned" forever (observed in prod: 17
// feedback items whose work items were DONE still said PLANNED). One shared
// mapping, applied by every column-writing path: the single-item PUT, the bulk
// route, the assistant executor, and Foreman's moveColumn.
import { prisma as defaultPrisma } from "@/lib/db/client";

/** The subset of the Prisma client this sync needs — accepts the root client, an
 *  interactive-transaction client, or Foreman's own instance. `workflowStatus` is
 *  optional so a client without it still syncs, by the key heuristic. */
export interface StatusSyncClient {
  workItem: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; columnKey: true; projectId: true };
    }): Promise<{ id: string; columnKey: string; projectId: string }[]>;
  };
  workflowStatus?: {
    findMany(args: {
      where: { projectId: { in: string[] } };
      select: { projectId: true; key: true; category: true };
    }): Promise<{ projectId: string; key: string; category: string }[]>;
  };
  feedbackItem: {
    updateMany(args: {
      where: {
        workItemId: { in: string[] };
        status: { notIn: ("DECLINED" | "DONE" | "IN_PROGRESS" | "IN_REVIEW" | "PLANNED" | "OPEN")[] };
      };
      data: { status: "PLANNED" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" };
    }): Promise<{ count: number }>;
  };
}

type FeedbackStatus = "PLANNED" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";

/** Map a work item's status to the status a feedback reporter should see.
 *  `null` = no opinion (a cancelled item, or an unknown custom column, never
 *  touches feedback).
 *
 *  The status's CATEGORY decides when someone set one: IN_PROGRESS is
 *  IN_PROGRESS, DONE is DONE. Statuses carry no "review" flag yet, so a
 *  review-named in-progress status is IN_REVIEW, parked for a human. TODO is
 *  the default every column gets when nobody chose, so it decides nothing on
 *  its own; with it, or without a category (a client that cannot read columns,
 *  a key no board shows), the key's spelling applies as it always has. */
export function feedbackStatusForColumn(columnKey: string, category?: string | null): FeedbackStatus | null {
  const k = columnKey.toLowerCase();
  switch (category) {
    case "DONE":
      return "DONE";
    case "IN_PROGRESS":
      return k.includes("review") ? "IN_REVIEW" : "IN_PROGRESS";
    case "CANCELLED":
      return null;
  }
  // No category, or TODO: TODO is the column default, stored for every column
  // created without one, so a "Completed" lane may carry it. The key's
  // spelling is the only reliable evidence then, as before categories.
  if (["done", "completed", "closed", "shipped"].some((w) => k.includes(w))) return "DONE";
  if (k.includes("review")) return "IN_REVIEW"; // parked for a human — distinct from active work
  if (["progress", "doing", "testing", "building"].some((w) => k.includes(w))) return "IN_PROGRESS";
  if (["backlog", "todo", "to-do", "new", "triage"].some((w) => k.includes(w))) return "PLANNED";
  return null;
}

/** Best-effort: reflect the CURRENT status of each work item onto its linked
 *  feedback item(s). Reads the items' statuses itself so callers just pass ids
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
      select: { id: true, columnKey: true, projectId: true },
    });
    // Each project's status categories.
    const categories = new Map<string, string>();
    const statuses = client.workflowStatus
      ? await client.workflowStatus.findMany({
          where: { projectId: { in: [...new Set(items.map((i) => i.projectId))] } },
          select: { projectId: true, key: true, category: true },
        })
      : [];
    for (const st of statuses) categories.set(`${st.projectId}:${st.key}`, st.category);
    // Group by target status so each status is one updateMany.
    const byStatus = new Map<FeedbackStatus, string[]>();
    for (const it of items) {
      const status = feedbackStatusForColumn(it.columnKey, categories.get(`${it.projectId}:${it.columnKey}`));
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
