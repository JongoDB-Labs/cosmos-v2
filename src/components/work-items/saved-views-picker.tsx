"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Bookmark, ChevronDown, Trash2, Users, Lock } from "lucide-react";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";

export interface SavedView {
  id: string;
  name: string;
  filter: WorkItemFilter;
  shared: boolean;
  mine: boolean;
  ownerName: string;
}

/**
 * Saved views picker (FR 2b36c2b8) — a Jira-style "saved filters" menu for the
 * Issues view. Lists the user's own views + org-shared ones, applies one on
 * click, and saves the current filter as a new (optionally shared) view.
 */
export function SavedViewsPicker({
  orgId,
  currentFilter,
  onApply,
}: {
  orgId: string;
  /** The live filter bar state, serialized — saved verbatim on "Save". */
  currentFilter: WorkItemFilter;
  onApply: (filter: WorkItemFilter) => void;
}) {
  const key = useOrgQueryKey("saved-views");
  const { data: views = [] } = useQuery({
    queryKey: key,
    queryFn: () => jsonFetch<SavedView[]>(`/api/v1/orgs/${orgId}/saved-views`),
    staleTime: 30_000,
  });

  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);

  const createView = useOrgMutation<SavedView, Error, { name: string; filter: WorkItemFilter; shared: boolean }>({
    mutationFn: (body) =>
      jsonFetch(`/api/v1/orgs/${orgId}/saved-views`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidate: [["saved-views"]],
  });

  const deleteView = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/saved-views/${id}`, { method: "DELETE" }),
    invalidate: [["saved-views"]],
  });

  const mine = views.filter((v) => v.mine);
  const sharedByOthers = views.filter((v) => !v.mine && v.shared);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await createView.mutateAsync({ name: trimmed, filter: currentFilter, shared });
      toast.success(`Saved view "${trimmed}"`);
      setSaveOpen(false);
      setName("");
      setShared(false);
    } catch (err) {
      notifyError(err, "Couldn't save the view.");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Saved views"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
            />
          }
        >
          <Bookmark className="h-4 w-4" /> Saved views
          <ChevronDown className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuItem onClick={() => setSaveOpen(true)}>
            <Bookmark className="mr-2 h-3.5 w-3.5" /> Save current filter…
          </DropdownMenuItem>
          {(mine.length > 0 || sharedByOthers.length > 0) && <DropdownMenuSeparator />}
          {mine.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>My views</DropdownMenuLabel>
              {mine.map((v) => (
                <ViewRow key={v.id} view={v} onApply={() => onApply(v.filter)} onDelete={() => deleteView.mutate(v.id)} deletable />
              ))}
            </DropdownMenuGroup>
          )}
          {sharedByOthers.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Shared with the team</DropdownMenuLabel>
              {sharedByOthers.map((v) => (
                <ViewRow key={v.id} view={v} onApply={() => onApply(v.filter)} />
              ))}
            </DropdownMenuGroup>
          )}
          {mine.length === 0 && sharedByOthers.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-[var(--text-muted)]">No saved views yet.</p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save current filter as a view</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder="View name (e.g. My open bugs)"
              maxLength={80}
            />
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 text-[var(--text)]">
                {shared ? <Users className="size-4" /> : <Lock className="size-4" />}
                {shared ? "Shared with the whole team" : "Only visible to me"}
              </span>
              <ToggleSwitch checked={shared} onCheckedChange={setShared} aria-label="Share with the team" />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={!name.trim() || createView.isPending}>
              {createView.isPending ? "Saving…" : "Save view"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ViewRow({
  view,
  onApply,
  onDelete,
  deletable = false,
}: {
  view: SavedView;
  onApply: () => void;
  onDelete?: () => void;
  deletable?: boolean;
}) {
  return (
    <div className="flex items-center">
      <DropdownMenuItem className="flex-1" onClick={onApply}>
        {view.shared ? (
          <Users className="mr-2 h-3.5 w-3.5 text-[var(--text-muted)]" />
        ) : (
          <Lock className="mr-2 h-3.5 w-3.5 text-[var(--text-muted)]" />
        )}
        <span className="truncate">{view.name}</span>
        {!view.mine && (
          <span className="ml-1 text-[10px] text-[var(--text-muted)]">· {view.ownerName}</span>
        )}
      </DropdownMenuItem>
      {deletable && onDelete && (
        <button
          type="button"
          aria-label={`Delete saved view ${view.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="mr-1 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--muted)]/50 hover:text-[var(--status-critical)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
