"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

/**
 * Per-ticket companion to ForemanGroomingFeed — a compact inline badge for the
 * work-item detail sheet showing what the supervisor last did (or, in dry mode,
 * proposed) for THIS ticket, with an Apply (dry) / Undo (live) affordance.
 *
 * Correctness notes:
 *  - We rank ALL groomed rows by time and look at the TRUE latest one. If that
 *    most-recent event is an `undo`/`leave` (or otherwise non-actionable), there
 *    is nothing to show — an earlier actionable row is stale (already reversed or
 *    superseded). Filtering `undo` out *before* ranking would resurface a stale
 *    "Undo" on an already-reversed action.
 *  - The detail sheet is ONE persistent instance whose `item` prop swaps (a user
 *    can jump to a linked/sub-item without a remount), so every async response is
 *    guarded: the effect uses a `cancelled` flag, and post-action refetches check
 *    an `activeItem` ref, so a late response for a previous ticket can't clobber
 *    the current one.
 *
 * Deliberately plain fetch (jsonFetch + useState/useEffect) rather than
 * react-query/useOrgMutation: this mounts inside CardDetailSheet, which loads all
 * its data the same way and isn't guaranteed a QueryClientProvider ancestor.
 *
 * Deliberately silent on loading/error: it sits in an already-busy sheet, so a
 * slow/failed fetch just renders nothing rather than a skeleton or error.
 */
interface GroomingRow {
  id: string;
  ts: string;
  ticketKey: string | null;
  workItemId: string | null;
  action: string;
  evidence: string;
  dupOf: string | null;
  dry: boolean;
  prClosed: boolean | null;
}

interface GroomingResponse {
  rows: GroomingRow[];
}

const ACTION_LABELS: Record<string, string> = {
  "deliver-close": "Deliver & close",
  "dedup-consolidate": "Dedup & consolidate",
  requeue: "Requeue",
  escalate: "Escalate",
};

const ACTION_VARIANTS: Record<string, BadgeVariant> = {
  "deliver-close": "done",
  "dedup-consolidate": "discovery",
  requeue: "progress",
  escalate: "critical",
};

// Actions worth surfacing on the badge. The true-latest row must be one of these
// (else render nothing — undo/leave/unknown carry no affordance).
const ACTIONABLE_ACTIONS = new Set(["deliver-close", "dedup-consolidate", "requeue", "escalate"]);
// A live (already-acted) row for one of these can be reversed via Undo. Escalate
// never acts on its own, so it is never undoable.
const UNDOABLE_ACTIONS = new Set(["deliver-close", "dedup-consolidate", "requeue"]);

export function ForemanGroomingBadge({ orgId, workItemId }: { orgId: string; workItemId: string }) {
  const [rows, setRows] = useState<GroomingRow[] | null>(null);
  const [pending, setPending] = useState<null | "apply" | "undo">(null);
  // The currently-mounted item, so a late async response for a PREVIOUS item
  // (the sheet is one persistent instance whose item swaps) can't clobber it.
  // Updated in the effect (never during render — a ref write in render is a lint
  // error and a correctness smell).
  const activeItem = useRef(workItemId);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    activeItem.current = workItemId;
    let cancelled = false;
    setRows(null);
    setPending(null);
    (async () => {
      try {
        const res = await jsonFetch<GroomingResponse>(
          `/api/v1/orgs/${orgId}/foreman/grooming?workItemId=${workItemId}`,
        );
        if (!cancelled) setRows(res.rows ?? []);
      } catch {
        if (!cancelled) setRows([]); // render nothing, but leave the loading state
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, workItemId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!rows) return null;
  // TRUE latest groomed row (any action), then decide if it's worth showing.
  const latest = [...rows].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())[0];
  if (!latest || !ACTIONABLE_ACTIONS.has(latest.action)) return null;

  const canApply = latest.dry;
  const canUndo = !latest.dry && UNDOABLE_ACTIONS.has(latest.action);

  async function runAction(kind: "apply" | "undo") {
    const item = workItemId;
    setPending(kind);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/foreman/grooming/${kind}`, {
        method: "POST",
        body: JSON.stringify({ workItemId: item }),
      });
      const res = await jsonFetch<GroomingResponse>(
        `/api/v1/orgs/${orgId}/foreman/grooming?workItemId=${item}`,
      );
      if (activeItem.current === item) setRows(res.rows ?? []);
    } catch (err) {
      notifyError(err);
    } finally {
      if (activeItem.current === item) setPending(null);
    }
  }

  return (
    <div className="flex items-center gap-1.5 text-xs" title={latest.evidence}>
      <span className="text-[var(--text-muted)]">Supervisor:</span>
      <Badge variant={ACTION_VARIANTS[latest.action] ?? "neutral"}>
        {ACTION_LABELS[latest.action] ?? latest.action}
      </Badge>
      {latest.dry && (
        <span className="rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          dry
        </span>
      )}
      {canApply && (
        <Button size="xs" variant="outline" disabled={pending !== null} onClick={() => void runAction("apply")}>
          Apply
        </Button>
      )}
      {canUndo && (
        <Button size="xs" variant="outline" disabled={pending !== null} onClick={() => void runAction("undo")}>
          Undo
        </Button>
      )}
    </div>
  );
}
