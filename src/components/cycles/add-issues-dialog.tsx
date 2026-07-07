"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
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

/**
 * "Add issues to a sprint" picker (FR 0e31d1ef). Cycle planning previously
 * meant editing each issue one at a time; this lets a planner multi-select
 * project issues from the Cycles workspace and move them into a cycle in one
 * action (via the bulk work-items endpoint). Moving an issue only changes its
 * cycle — status/column are untouched.
 */

interface WorkItemLite {
  id: string;
  title: string;
  ticketNumber: number;
  cycleId: string | null;
}

interface AddIssuesDialogProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  cycle: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after issues are successfully added (parent refetches cycles). */
  onAdded: () => void;
  /** cycleId → cycle name, for the "currently in X" badge on candidates. */
  cycleNames: Record<string, string>;
}

export function AddIssuesDialog({
  orgId,
  projectId,
  projectKey,
  cycle,
  open,
  onOpenChange,
  onAdded,
  cycleNames,
}: AddIssuesDialogProps) {
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const [items, setItems] = useState<WorkItemLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  // Load candidate issues each time the dialog opens.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !cycle) return;
    let cancelled = false;
    setLoading(true);
    setSelected(new Set());
    setQuery("");
    (async () => {
      try {
        const res = await fetch(`${basePath}/work-items`);
        if (!res.ok) throw new Error("Failed to load issues");
        const all: WorkItemLite[] = await res.json();
        if (!cancelled) setItems(all);
      } catch (err) {
        if (!cancelled) notifyError(err, "Couldn't load issues.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, cycle, basePath]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Candidates = everything not already in THIS cycle, matching the search.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => i.cycleId !== cycle?.id)
      .filter(
        (i) =>
          !q ||
          i.title.toLowerCase().includes(q) ||
          `${projectKey}-${i.ticketNumber}`.toLowerCase().includes(q),
      );
  }, [items, cycle, query, projectKey]);

  const allVisibleSelected =
    candidates.length > 0 && candidates.every((c) => selected.has(c.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (candidates.every((c) => next.has(c.id))) {
        candidates.forEach((c) => next.delete(c.id));
      } else {
        candidates.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  const addSelected = useCallback(async () => {
    if (!cycle || selected.size === 0) return;
    setSaving(true);
    try {
      const res = await fetch(`${basePath}/work-items/bulk`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected], update: { cycleId: cycle.id } }),
      });
      if (!res.ok) throw new Error("Failed to add issues");
      onAdded();
      onOpenChange(false);
    } catch (err) {
      notifyError(err, "Couldn't add the selected issues to the cycle.");
    } finally {
      setSaving(false);
    }
  }, [cycle, selected, basePath, onAdded, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add issues to {cycle?.name}</DialogTitle>
          <DialogDescription>
            Pick issues to move into this cycle. Their status doesn&apos;t change — only the cycle.
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

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <button
            type="button"
            className="hover:text-foreground disabled:opacity-50"
            onClick={toggleAll}
            disabled={candidates.length === 0}
          >
            {allVisibleSelected ? "Clear all" : "Select all"} ({candidates.length})
          </button>
          <span>{selected.size} selected</span>
        </div>

        <div className="max-h-72 divide-y overflow-y-auto rounded-md border">
          {loading ? (
            <div className="space-y-2 p-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : candidates.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {items.length === 0 ? "No issues in this project yet." : "Every issue is already in this cycle."}
            </p>
          ) : (
            candidates.map((i) => (
              <label
                key={i.id}
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50"
              >
                <Checkbox checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {projectKey}-{i.ticketNumber}
                </span>
                <span className="flex-1 truncate">{i.title}</span>
                {i.cycleId && cycleNames[i.cycleId] && (
                  <Badge variant="neutral" className="shrink-0 text-[10px]">
                    {cycleNames[i.cycleId]}
                  </Badge>
                )}
              </label>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void addSelected()} disabled={saving || selected.size === 0}>
            {saving ? "Adding…" : selected.size > 0 ? `Add ${selected.size}` : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
