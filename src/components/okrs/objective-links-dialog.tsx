"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
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
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import { orderByPreferredType, resolveLinkTypeId } from "@/lib/okr/link-type-default";

interface WorkItemLite {
  id: string;
  title: string;
  ticketNumber: number;
  completedAt: string | null;
  workItemTypeId?: string | null;
}

interface LinkedRow {
  linkId: string;
  id: string;
}

/**
 * Pick the work items an Objective is delivered by (#52).
 *
 * The point of the feature: a stakeholder reading a PI Objective wants to see
 * the Features that deliver it, not only key-result numbers. The project's
 * configured type is offered FIRST (Feature by default) while every other type
 * stays linkable — an org mid-transition must not be blocked.
 *
 * Objective→OBJECTIVE laddering is NOT here: `Objective.parentId` already does
 * that and is edited in the objective's own Edit dialog.
 */
export function ObjectiveLinksDialog({
  orgId,
  projectId,
  objectiveId,
  objectiveTitle,
  open,
  onOpenChange,
  onChanged,
}: {
  orgId: string;
  projectId: string;
  objectiveId: string;
  objectiveTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const params = useParams<{ projectKey: string }>();
  const projectKey = params?.projectKey ?? "";
  const base = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const [items, setItems] = useState<WorkItemLite[]>([]);
  const [linked, setLinked] = useState<LinkedRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: project } = useQuery({
    queryKey: useOrgQueryKey("project", projectId),
    queryFn: () => jsonFetch<{ objectiveLinkTypeId: string | null }>(base),
    staleTime: 60_000,
  });
  const { types } = useWorkItemTypes(orgId);
  const preferredTypeId = resolveLinkTypeId(project?.objectiveLinkTypeId, types);
  const preferredTypeName = types.find((t) => t.id === preferredTypeId)?.name ?? null;

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setQuery("");
    (async () => {
      try {
        const [all, current] = await Promise.all([
          jsonFetch<WorkItemLite[]>(`${base}/work-items`),
          jsonFetch<LinkedRow[]>(`${base}/objectives/${objectiveId}/links`),
        ]);
        if (cancelled) return;
        setItems(all);
        setLinked(current);
        setSelected(new Set(current.map((l) => l.id)));
      } catch (err) {
        if (!cancelled) notifyError(err, "Couldn't load tickets.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, base, objectiveId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const original = useMemo(() => new Set(linked.map((l) => l.id)), [linked]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = items.filter(
      (i) =>
        !q ||
        i.title.toLowerCase().includes(q) ||
        `${projectKey}-${i.ticketNumber}`.toLowerCase().includes(q),
    );
    return orderByPreferredType(matching, preferredTypeId);
  }, [items, query, projectKey, preferredTypeId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const toAdd = [...selected].filter((id) => !original.has(id));
      const toRemove = [...original].filter((id) => !selected.has(id));
      const url = `${base}/objectives/${objectiveId}/links`;
      await Promise.all([
        ...toAdd.map((workItemId) =>
          jsonFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workItemId }),
          }),
        ),
        ...toRemove.map((workItemId) =>
          jsonFetch(url, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workItemId }),
          }),
        ),
      ]);
      onChanged();
      onOpenChange(false);
    } catch (err) {
      notifyError(err, "Couldn't save the links.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link work items to “{objectiveTitle}”</DialogTitle>
          <DialogDescription>
            The delivery this objective is tracked against.
            {preferredTypeName
              ? ` ${preferredTypeName}s are listed first; any ticket can still be linked.`
              : null}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search tickets..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="max-h-72 space-y-1 overflow-y-auto">
          {loading ? (
            <>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </>
          ) : shown.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              No tickets match.
            </p>
          ) : (
            shown.map((i) => (
              <label
                key={i.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--surface)]"
              >
                <Checkbox checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {projectKey}-{i.ticketNumber}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{i.title}</span>
              </label>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving ? "Saving..." : "Save links"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
