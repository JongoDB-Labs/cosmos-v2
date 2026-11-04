"use client";

import { useState } from "react";
import { Lock, LockOpen, Loader2 } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";
import { formatDateStable } from "@/lib/format/stable-date";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { useCloseEvidencePrompt } from "@/components/pm-dashboard/close-evidence-prompt";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface PhaseClosureState {
  id: string;
  name: string;
  closedAt: string | null;
  /** Who closed it, as a name; the caller resolves it. */
  closedByName?: string | null;
}

/**
 * Close or reopen a phase (POST …/phases/{id}/close and …/reopen).
 *
 * Closing is an explicit act, never inferred from percent complete. Under the
 * closing rule it needs a supporting file on the phase or a recorded reason;
 * the server says which, and the same prompt the deliverable tracker uses asks
 * for the reason and retries. Reopening asks for confirmation, because it makes
 * a signed-off record editable again.
 *
 * Shown to everyone; the buttons only to PROJECT_UPDATE holders (the server
 * also admits a manager of this project, and is the authority either way).
 */
export function PhaseClosure({
  orgId,
  projectId,
  phase,
  onChanged,
}: {
  orgId: string;
  projectId: string;
  phase: PhaseClosureState;
  /** After a close or reopen succeeds, so the caller can refetch. */
  onChanged?: () => void;
}) {
  const { can } = usePermissions();
  const canChange = can(Permission.PROJECT_UPDATE);
  const [state, setState] = useState(phase);
  const [busy, setBusy] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const evidence = useCloseEvidencePrompt();
  const base = `/api/v1/orgs/${orgId}/projects/${projectId}/phases/${phase.id}`;

  async function close() {
    setBusy(true);
    try {
      const closed = await evidence.withEvidence((extra) =>
        jsonFetch<{ closedAt: string | null }>(`${base}/close`, { method: "POST", body: JSON.stringify(extra) }),
      );
      setState((s) => ({ ...s, closedAt: closed.closedAt, closedByName: "you" }));
      onChanged?.();
    } catch (e) {
      notifyError(e, "Couldn't close the phase.");
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    setConfirmReopen(false);
    setBusy(true);
    try {
      await jsonFetch(`${base}/reopen`, { method: "POST", body: "{}" });
      setState((s) => ({ ...s, closedAt: null, closedByName: null }));
      onChanged?.();
    } catch (e) {
      notifyError(e, "Couldn't reopen the phase.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm" data-testid="phase-closure">
      <span className="flex items-center gap-2">
        {state.closedAt ? <Lock className="size-4 text-muted-foreground" /> : <LockOpen className="size-4 text-muted-foreground" />}
        {state.closedAt ? (
          <span>
            Closed {formatDateStable(state.closedAt)}
            {state.closedByName ? ` by ${state.closedByName}` : ""}
            <span className="block text-xs text-muted-foreground">Read-only until it is reopened.</span>
          </span>
        ) : (
          <span>Open</span>
        )}
      </span>
      {canChange &&
        (state.closedAt ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmReopen(true)}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Reopen phase
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void close()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Close phase
          </Button>
        ))}

      <Dialog open={confirmReopen} onOpenChange={setConfirmReopen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reopen {state.name}?</DialogTitle>
            <DialogDescription>
              It becomes editable again, and its files can be taken off it. Reopening is recorded.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReopen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void reopen()}>Reopen</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {evidence.dialog}
    </div>
  );
}
