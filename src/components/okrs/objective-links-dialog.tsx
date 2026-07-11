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
import type { KeyResultLinkedItem, ObjectiveDependency } from "@/types/models";

interface WorkItemLite {
  id: string;
  title: string;
  ticketNumber: number;
  completedAt: string | null;
}

interface ObjectiveLite {
  id: string;
  title: string;
}

interface ObjectiveLinksDialogProps {
  orgId: string;
  projectId: string;
  objectiveId: string;
  objectiveTitle: string;
  /** Work items currently linked directly to the objective (to pre-select). */
  linkedItems: KeyResultLinkedItem[];
  /** Objectives this one currently depends on (to pre-select). */
  dependencies: ObjectiveDependency[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after links are saved so the OKR board refetches progress. */
  onChanged: () => void;
}

/**
 * COSMOS-82: pick the work items that DELIVER an objective and the other
 * objectives it DEPENDS ON. Multi-select, pre-seeded from the objective's
 * current links; saving diffs each selection against the original and
 * POSTs/DELETEs the changed links. The objective's progress then folds in how
 * many linked deliverables are done.
 */
export function ObjectiveLinksDialog({
  orgId,
  projectId,
  objectiveId,
  objectiveTitle,
  linkedItems,
  dependencies,
  open,
  onOpenChange,
  onChanged,
}: ObjectiveLinksDialogProps) {
  const params = useParams<{ projectKey: string }>();
  const projectKey = params?.projectKey ?? "";
  const base = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const [items, setItems] = useState<WorkItemLite[]>([]);
  const [objectives, setObjectives] = useState<ObjectiveLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [selectedDeps, setSelectedDeps] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const originalItems = useMemo(() => new Set(linkedItems.map((i) => i.id)), [linkedItems]);
  const originalDeps = useMemo(() => new Set(dependencies.map((d) => d.id)), [dependencies]);
  const depCandidates = useMemo(
    () => objectives.filter((o) => o.id !== objectiveId),
    [objectives, objectiveId],
  );

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setSelectedItems(new Set(linkedItems.map((i) => i.id)));
    setSelectedDeps(new Set(dependencies.map((d) => d.id)));
    setQuery("");
    (async () => {
      try {
        const [itemsRes, objsRes] = await Promise.all([
          fetch(`${base}/work-items`),
          fetch(`${base}/objectives`),
        ]);
        if (!itemsRes.ok || !objsRes.ok) throw new Error("load");
        const allItems: WorkItemLite[] = await itemsRes.json();
        const allObjs: ObjectiveLite[] = await objsRes.json();
        if (!cancelled) {
          setItems(allItems);
          setObjectives(allObjs);
        }
      } catch (err) {
        if (!cancelled) notifyError(err, "Couldn't load tickets.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, base, linkedItems, dependencies]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const shownItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        !q ||
        i.title.toLowerCase().includes(q) ||
        `${projectKey}-${i.ticketNumber}`.toLowerCase().includes(q),
    );
  }, [items, query, projectKey]);

  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const url = `${base}/objectives/${objectiveId}/links`;
      const post = (kind: "WORK_ITEM" | "DEPENDS_ON", targetId: string) =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, targetId }),
        });
      const del = (kind: "WORK_ITEM" | "DEPENDS_ON", targetId: string) =>
        fetch(url, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, targetId }),
        });

      await Promise.all([
        ...[...selectedItems]
          .filter((id) => !originalItems.has(id))
          .map((id) => post("WORK_ITEM", id)),
        ...[...originalItems]
          .filter((id) => !selectedItems.has(id))
          .map((id) => del("WORK_ITEM", id)),
        ...[...selectedDeps].filter((id) => !originalDeps.has(id)).map((id) => post("DEPENDS_ON", id)),
        ...[...originalDeps].filter((id) => !selectedDeps.has(id)).map((id) => del("DEPENDS_ON", id)),
      ]);
      onChanged();
      onOpenChange(false);
    } catch (err) {
      notifyError(err, "Couldn't save the objective's links.");
    } finally {
      setSaving(false);
    }
  }, [selectedItems, originalItems, selectedDeps, originalDeps, base, objectiveId, onChanged, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link work &amp; dependencies to “{objectiveTitle}”</DialogTitle>
          <DialogDescription>
            Linked tickets deliver this objective — its progress tracks how many are done.
            Dependencies are other objectives this one relies on.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Deliverables (tickets)</p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title or key…"
              className="pl-8"
            />
          </div>
          <div className="text-xs text-muted-foreground">{selectedItems.size} linked</div>
          <div className="max-h-52 divide-y overflow-y-auto rounded-md border">
            {loading ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : shownItems.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No tickets found.</p>
            ) : (
              shownItems.map((i) => (
                <label
                  key={i.id}
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50"
                >
                  <Checkbox
                    checked={selectedItems.has(i.id)}
                    onChange={() => toggle(setSelectedItems, i.id)}
                  />
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
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Dependencies (objectives)</p>
          <div className="max-h-40 divide-y overflow-y-auto rounded-md border">
            {depCandidates.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                No other objectives to depend on.
              </p>
            ) : (
              depCandidates.map((o) => (
                <label
                  key={o.id}
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50"
                >
                  <Checkbox
                    checked={selectedDeps.has(o.id)}
                    onChange={() => toggle(setSelectedDeps, o.id)}
                  />
                  <span className="flex-1 truncate">{o.title}</span>
                </label>
              ))
            )}
          </div>
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
