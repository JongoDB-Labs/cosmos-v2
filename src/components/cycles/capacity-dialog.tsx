"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOrgMembers } from "@/components/chat/mention-typeahead";
import { notifyError } from "@/lib/errors/notify";

interface CapacityEntry {
  userId: string;
  capacity: number;
  user: { id: string; displayName: string };
}

interface CapacityDialogProps {
  orgId: string;
  projectId: string;
  cycleId: string;
  cycleName: string;
  canEdit: boolean;
  onClose: () => void;
}

/**
 * Per-member capacity planning for a cycle. Reads/writes the existing
 * /cycles/[id]/capacity route (GET returns CycleCapacity rows; PUT upserts an
 * `entries` array and removes anyone omitted). Candidate members come from the
 * org member list — their User ids are the uuids the route expects.
 */
export function CapacityDialog({
  orgId,
  projectId,
  cycleId,
  cycleName,
  canEdit,
  onClose,
}: CapacityDialogProps) {
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}/cycles/${cycleId}`;
  const { data: members } = useOrgMembers(orgId);

  // userId -> hours, as a string for the controlled input.
  const [hours, setHours] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadCapacity = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${basePath}/capacity`);
      if (!res.ok) throw new Error("Failed to load capacity");
      const rows: CapacityEntry[] = await res.json();
      const map: Record<string, string> = {};
      for (const r of rows) map[r.userId] = String(r.capacity);
      setHours(map);
    } catch (err) {
      notifyError(err, "Couldn't load capacity.");
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    loadCapacity();
  }, [loadCapacity]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function save() {
    setSaving(true);
    try {
      const entries = Object.entries(hours)
        .map(([userId, h]) => ({ userId, capacity: Number(h) }))
        .filter((e) => Number.isFinite(e.capacity) && e.capacity > 0);
      const res = await fetch(`${basePath}/capacity`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) throw new Error("Failed to save capacity");
      onClose();
    } catch (err) {
      notifyError(err, "Couldn't save capacity.");
    } finally {
      setSaving(false);
    }
  }

  const total = Object.values(hours).reduce((sum, h) => {
    const n = Number(h);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Capacity — {cycleName}</DialogTitle>
          <DialogDescription>
            Planned hours per member for this cycle. Used alongside velocity to
            flag over-commitment.
          </DialogDescription>
        </DialogHeader>

        {loading || !members ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : members.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            No members to plan capacity for.
          </p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto py-1">
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-3">
                <span className="truncate text-sm">{m.displayName}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    aria-label={`Capacity hours for ${m.displayName}`}
                    className="w-24"
                    disabled={!canEdit}
                    value={hours[m.id] ?? ""}
                    onChange={(e) =>
                      setHours((prev) => ({ ...prev, [m.id]: e.target.value }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">hrs</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="items-center justify-between sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Total: <span className="font-medium text-foreground">{total} hrs</span>
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              {canEdit ? "Cancel" : "Close"}
            </Button>
            {canEdit && (
              <Button onClick={save} disabled={saving || loading}>
                {saving ? "Saving…" : "Save capacity"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
