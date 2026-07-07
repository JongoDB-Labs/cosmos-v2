"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { notifyError } from "@/lib/errors/notify";
import { Search } from "lucide-react";
import type { KeyResultLinkedItem } from "@/types/models";

interface WorkItemLite {
  id: string;
  title: string;
  ticketNumber: number;
  completedAt: string | null;
}

interface KeyResultLinksDialogProps {
  orgId: string;
  projectId: string;
  keyResultId: string;
  keyResultTitle: string;
  /** Currently-linked tickets (to pre-select). */
  linkedItems: KeyResultLinkedItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after links are saved so the OKR board refetches progress. */
  onChanged: () => void;
}

/**
 * Pick the tickets that deliver a Key Result (FR a94ff583). Multi-select of the
 * project's work items, pre-seeded from the KR's current links; saving diffs the
 * selection against the original and POSTs/DELETEs the changed links. A KR with
 * links then auto-tracks (progress = # done linked tickets).
 */
export function KeyResultLinksDialog({
  orgId,
  projectId,
  keyResultId,
  keyResultTitle,
  linkedItems,
  open,
  onOpenChange,
  onChanged,
}: KeyResultLinksDialogProps) {
  const params = useParams<{ projectKey: string }>();
  const projectKey = params?.projectKey ?? "";
  const base = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const [items, setItems] = useState<WorkItemLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const original = useMemo(() => new Set(linkedItems.map((i) => i.id)), [linkedItems]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setSelected(new Set(linkedItems.map((i) => i.id)));
    setQuery("");
    (async () => {
      try {
        const res = await fetch(`${base}/work-items`);
        if (!res.ok) throw new Error("load");
        const all: WorkItemLite[] = await res.json();
        if (!cancelled) setItems(all);
      } catch (err) {
        if (!cancelled) notifyError(err, "Couldn't load tickets.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, base, linkedItems]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        !q ||
        i.title.toLowerCase().includes(q) ||
        `${projectKey}-${i.ticketNumber}`.toLowerCase().includes(q),
    );
  }, [items, query, projectKey]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const toAdd = [...selected].filter((id) => !original.has(id));
      const toRemove = [...original].filter((id) => !selected.has(id));
      const url = `${base}/key-results/${keyResultId}/links`;
      await Promise.all([
        ...toAdd.map((workItemId) =>
          fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workItemId }),
          }),
        ),
        ...toRemove.map((workItemId) =>
          fetch(url, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workItemId }),
          }),
        ),
      ]);
      onChanged();
      onOpenChange(false);
    } catch (err) {
      notifyError(err, "Couldn't save the linked tickets.");
    } finally {
      setSaving(false);
    }
  }, [selected, original, base, keyResultId, onChanged, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link tickets to “{keyResultTitle}”</DialogTitle>
          <DialogDescription>
            Selected tickets deliver this key result — its progress tracks how many are done.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title or key…"
            className="pl-8"
          />
        </div>
        <div className="text-xs text-muted-foreground">{selected.size} linked</div>

        <div className="max-h-72 divide-y overflow-y-auto rounded-md border">
          {loading ? (
            <div className="space-y-2 p-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No tickets found.</p>
          ) : (
            shown.map((i) => (
              <label
                key={i.id}
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50"
              >
                <Checkbox checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {projectKey ? `${projectKey}-${i.ticketNumber}` : `#${i.ticketNumber}`}
                </span>
                <span className="flex-1 truncate">{i.title}</span>
                {i.completedAt && (
                  <span className="shrink-0 text-[10px] font-medium text-green-500">done</span>
                )}
              </label>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save links"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
