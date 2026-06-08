"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { notifyError } from "@/lib/errors/notify";

interface OrgDangerZoneProps {
  orgId: string;
  orgName: string;
}

/**
 * Delete the organization — irreversible hard delete that cascades every
 * project, board, work item, member, integration, etc. Only rendered when the
 * caller holds ORG_DELETE (owner). Requires typing the exact org name to arm
 * the button, and the server re-checks that name as a second gate.
 */
export function OrgDangerZone({ orgId, orgName }: OrgDangerZoneProps) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const armed = confirm === orgName && !busy;

  async function del() {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: confirm }),
      });
      if (!res.ok && res.status !== 204) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't delete the organization.");
      }
      // The org (and this route's [orgSlug]) no longer exists — hard-navigate
      // to the root, which resolves to the org picker / onboarding.
      window.location.href = "/";
    } catch (err) {
      notifyError(err, "Couldn't delete the organization.");
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--status-critical)]/40 bg-[var(--status-critical)]/5 p-5">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-[var(--status-critical)]" />
        <h3 className="text-sm font-semibold text-[var(--status-critical)]">Danger zone</h3>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <p className="text-sm font-medium">Delete this organization</p>
          <p className="text-xs text-[var(--text-muted)]">
            Permanently deletes <span className="font-medium">{orgName}</span> and
            everything in it — projects, boards, work items, members,
            integrations, files, and settings. This cannot be undone.
          </p>
        </div>
        <Button
          variant="destructive"
          className="shrink-0"
          onClick={() => {
            setConfirm("");
            setOpen(true);
          }}
        >
          Delete organization
        </Button>
      </div>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {orgName}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the organization and all of its data.
              This action <b>cannot be undone</b>. To confirm, type the
              organization name below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-name">
              Type <span className="font-mono">{orgName}</span> to confirm
            </Label>
            <Input
              id="confirm-name"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              placeholder={orgName}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={del} disabled={!armed}>
              {busy ? "Deleting…" : "Delete organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
