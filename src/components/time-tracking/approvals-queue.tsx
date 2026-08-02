"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateStable } from "@/lib/format/stable-date";

/**
 * Weeks waiting on YOU.
 *
 * Approval routing has told approvers a week arrived since 2.255.0, but the
 * only way to reach one was the notification that announced it. A notification
 * is read once and then gone, so an approver who dismissed it — or who simply
 * opens the page on a Monday — had no way to see what they owed. The query has
 * been ready the whole time (`approverIds` carries a GIN index); nothing
 * rendered it.
 *
 * Driven by the ROUTING STAMP, not by authority. `approverIds` records who was
 * ASKED; authority is a wider set, and using it would fill an admin's queue
 * with every open week in the org — most of them somebody else's job.
 */
export type QueuedSheet = {
  id: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  workerName: string | null;
};

/**
 * Oldest first: the longest-waiting week is the most overdue, and a queue that
 * buries it under this morning's submission is a queue that grows a tail.
 */
export function orderQueue(sheets: QueuedSheet[]): QueuedSheet[] {
  return [...sheets].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

/** "3 weeks waiting on you" — plural-correct, because "1 weeks" reads as a bug. */
export function queueLabel(count: number): string {
  return count === 1 ? "1 week waiting on you" : `${count} weeks waiting on you`;
}

export function ApprovalsQueue({
  orgId,
  refreshKey,
  onOpen,
}: {
  orgId: string;
  /** Bumped by the parent after an approval, so the queue drops what it just lost. */
  refreshKey: number;
  onOpen: (userId: string, periodStart: string) => void;
}) {
  const [sheets, setSheets] = useState<QueuedSheet[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    // DEFERRED OFF THE CRITICAL PATH, deliberately.
    //
    // This request is not what the page is for — the week grid is — and issuing
    // it during mount makes it compete with the load the user is waiting on. It
    // showed up as an intermittent e2e failure on an unrelated time-tracking
    // spec: in dev the extra route has to be compiled on first hit, which
    // delayed the very load that test was measuring. The queue is worth a beat
    // of latency; the grid is not.
    const schedule =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback
        : (fn: () => void) => setTimeout(fn, 0);

    const handle = schedule(() => {
      (async () => {
        try {
          const res = await fetch(
            `/api/v1/orgs/${orgId}/timesheets?awaitingMe=1`,
          );
          if (cancelled || !res.ok) return;
          const body = await res.json();
          if (!cancelled) setSheets(body.data ?? []);
        } catch {
          // The queue simply does not render. It is an accelerator, not the
          // only route to a week — the person picker still works.
        }
      })();
    });

    return () => {
      cancelled = true;
      if (typeof cancelIdleCallback === "function") {
        cancelIdleCallback(handle as number);
      } else {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }
    };
  }, [orgId, refreshKey]);

  // Nothing waiting renders NOTHING, not an empty panel. A permanently present
  // "0 waiting" box is the fastest way to teach someone to stop looking at it.
  if (!sheets || sheets.length === 0) return null;

  const ordered = orderQueue(sheets);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{queueLabel(ordered.length)}</span>
      </div>

      <div className="flex flex-col gap-1">
        {ordered.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background/60 px-2 py-1.5 text-sm"
          >
            <span className="flex items-center gap-2">
              {/* The name leads: an approver is deciding WHOSE hours these are
                  before they care which week. */}
              <span className="font-medium">{s.workerName ?? "Someone"}</span>
              <span className="text-muted-foreground">
                {formatDateStable(s.periodStart)} – {formatDateStable(s.periodEnd)}
              </span>
              {s.status === "LABOR_APPROVED" && (
                // Under a two-lane policy this week has passed labor approval
                // and is waiting on cost. Saying so stops an approver hunting
                // for an Approve button that has already been pressed.
                <Badge variant="review">Awaiting cost</Badge>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              // Names the person, because every row renders one of these and
              // "Open" alone repeats N times to a screen reader.
              aria-label={`Open ${s.workerName ?? "this"} week of ${formatDateStable(s.periodStart)}`}
              onClick={() => onOpen(s.userId, s.periodStart)}
            >
              Open
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
