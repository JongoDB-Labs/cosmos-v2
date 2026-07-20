"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

/**
 * Per-ticket companion to ForemanGroomingFeed — a compact inline badge for
 * the work-item detail sheet showing what the supervisor last did (or, in
 * dry mode, proposed) for THIS ticket. Same row shape and action semantics
 * as the feed: GET .../foreman/grooming?workItemId=... (the route's
 * per-ticket filter), find the latest ACTIONABLE row (ignore "undo" and
 * "leave" — those never carry an Apply/Undo affordance here), and render a
 * chip + Apply/Undo button using the same jsonFetch/notifyError/button-
 * disable-while-pending idiom as the feed.
 *
 * Deliberately plain fetch (jsonFetch + useState/useEffect) rather than
 * react-query/useOrgMutation: this mounts inside CardDetailSheet, which
 * itself does all its data-loading the same way (see the comments/activity/
 * watch effects above) and isn't guaranteed a QueryClientProvider ancestor
 * wherever the sheet is rendered. Reusing useOrgQueryKey/useOrgMutation here
 * would pull in useOrgSlug (via usePathname), which isn't safe to call from
 * every context the sheet mounts in — so this stays self-contained.
 *
 * Deliberately silent on loading/error: this sits in an already-busy detail
 * sheet, so a slow or failed fetch should never show a skeleton or error
 * state — it should just not be there. `null` is also the correct render
 * when there's no actionable history for this ticket.
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

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function actionVariant(action: string): BadgeVariant {
  return ACTION_VARIANTS[action] ?? "neutral";
}

// The rows this badge will ever surface as the "latest" one — mirrors the
// feed's APPLICABLE_ACTIONS/UNDOABLE_ACTIONS split. "undo" and "leave" rows
// are never actionable and are skipped when finding the latest row to show.
const ACTIONABLE_ACTIONS = new Set(["deliver-close", "dedup-consolidate", "requeue", "escalate"]);

// A dry row proposing one of these actions can be carried out via Apply.
const APPLICABLE_ACTIONS = new Set(["deliver-close", "dedup-consolidate", "requeue", "escalate"]);

// A live (already-acted) row for one of these actions can be reversed via
// Undo. Escalate never acts on its own, so it's never undoable.
const UNDOABLE_ACTIONS = new Set(["deliver-close", "dedup-consolidate", "requeue"]);

export function ForemanGroomingBadge({
  orgId,
  workItemId,
}: {
  orgId: string;
  workItemId: string;
}) {
  const [rows, setRows] = useState<GroomingRow[] | null>(null);
  const [pending, setPending] = useState<null | "apply" | "undo">(null);

  const load = useCallback(async () => {
    try {
      const res = await jsonFetch<GroomingResponse>(
        `/api/v1/orgs/${orgId}/foreman/grooming?workItemId=${workItemId}`,
      );
      setRows(res.rows ?? []);
    } catch {
      // Errors render nothing — see file doc. Leave `rows` as-is (null on
      // first load, or the last-good rows on a refetch failure).
    }
  }, [orgId, workItemId]);

  // Reset to the loading (null) state on every workItemId change so a badge
  // never briefly shows the PREVIOUS ticket's action while the new fetch is
  // in flight — same "derive state from prop" pattern (and eslint escape
  // hatch) as the item-sync effect in card-detail-sheet.tsx.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!rows) return null;

  const latest = [...rows]
    .filter((r) => ACTIONABLE_ACTIONS.has(r.action))
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())[0];
  if (!latest) return null;

  const canApply = latest.dry && APPLICABLE_ACTIONS.has(latest.action);
  const canUndo = !latest.dry && UNDOABLE_ACTIONS.has(latest.action);

  async function runAction(kind: "apply" | "undo") {
    setPending(kind);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/foreman/grooming/${kind}`, {
        method: "POST",
        body: JSON.stringify({ workItemId }),
      });
      await load();
    } catch (err) {
      notifyError(err);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex items-center gap-1.5 text-xs" title={latest.evidence}>
      <span className="text-[var(--text-muted)]">Supervisor:</span>
      <Badge variant={actionVariant(latest.action)}>{actionLabel(latest.action)}</Badge>
      {latest.dry && (
        <span className="rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          dry
        </span>
      )}
      {canApply && (
        <Button
          size="xs"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void runAction("apply")}
        >
          Apply
        </Button>
      )}
      {canUndo && (
        <Button
          size="xs"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void runAction("undo")}
        >
          Undo
        </Button>
      )}
    </div>
  );
}
