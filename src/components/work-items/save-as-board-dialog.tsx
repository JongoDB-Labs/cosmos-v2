"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";

/** The board types a saved view can render today (kanban + table cover the set
 *  the work-items load is wired for; others are "coming soon"). */
const BOARD_TYPES = [
  { value: "KANBAN", label: "Board (Kanban)" },
  { value: "TABLE", label: "Table" },
] as const;

interface ProjectOption {
  id: string;
  key: string;
  name: string;
  archived: boolean;
}

/** Minimal shape of the board create response we need to navigate. */
interface CreatedBoard {
  id: string;
  slug: string | null;
}

export interface SaveAsBoardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  orgSlug: string;
  /** The filter currently active in the Issues view (already RBAC-scoped on
   *  read; stored verbatim, minus any project pin, on the new board). */
  filter: WorkItemFilter;
  /** Readable, non-archived projects the board may be created in. */
  projects: ProjectOption[];
  /** Pre-select this project (e.g. the one the Issues view is filtered to). */
  defaultProjectId?: string;
}

/**
 * "Save as board" — turn the current Issues search into a project-scoped saved
 * view. A saved board is project-scoped even though Issues is cross-project, so
 * the user picks ONE target project; the board then shows that project's items
 * matching the filter (the saved filter's own project pin is dropped — the
 * server pins scope to the board's project on every read). RBAC: only projects
 * the user can read are offered, and the create route gates on BOARD_CREATE.
 */
export function SaveAsBoardDialog({
  open,
  onOpenChange,
  orgId,
  orgSlug,
  filter,
  projects,
  defaultProjectId,
}: SaveAsBoardDialogProps) {
  const router = useRouter();
  const selectableProjects = useMemo(
    () => projects.filter((p) => !p.archived),
    [projects],
  );

  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<string>(
    defaultProjectId && selectableProjects.some((p) => p.id === defaultProjectId)
      ? defaultProjectId
      : (selectableProjects[0]?.id ?? ""),
  );
  const [boardType, setBoardType] = useState<string>("KANBAN");

  // Strip the project pin from the saved filter — the board carries its own
  // project, and the server re-pins scope to it on every read. (`projectIds`
  // here would only narrow further, but it's misleading to persist a foreign
  // project on a board pinned to another, so drop it.)
  const savedFilter = useMemo<WorkItemFilter>(() => {
    const rest = { ...filter };
    delete rest.projectIds;
    return rest;
  }, [filter]);

  const createMutation = useOrgMutation<CreatedBoard, Error, void>({
    mutationFn: () =>
      jsonFetch<CreatedBoard>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/boards`,
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            type: boardType,
            config: { savedFilter },
          }),
        },
      ),
    // The new board appears in the project's board tabs (server-rendered), so
    // invalidate the boards list for that project's cache namespace.
    invalidate: [["boards", projectId]],
    onSuccess: (board) => {
      const project = selectableProjects.find((p) => p.id === projectId);
      onOpenChange(false);
      setName("");
      if (project) {
        router.push(
          `/${orgSlug}/projects/${project.key}/boards/${board.slug ?? board.id}`,
        );
      }
    },
  });

  const canSubmit =
    name.trim().length > 0 && projectId.length > 0 && !createMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as board</DialogTitle>
          <DialogDescription>
            Create a board that shows a project&apos;s work items matching your
            current filter. A saved board is project-scoped, so pick which
            project it should track.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) createMutation.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="saved-board-name">Board name</Label>
            <Input
              id="saved-board-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My open bugs"
              maxLength={100}
              autoFocus
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="saved-board-project">Project</Label>
            {selectableProjects.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                No projects available to save into.
              </p>
            ) : (
              <Select
                value={projectId}
                onValueChange={(v) => v && setProjectId(v as string)}
              >
                <SelectTrigger id="saved-board-project" aria-label="Target project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectableProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.key} · {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="saved-board-type">View type</Label>
            <Select
              value={boardType}
              onValueChange={(v) => v && setBoardType(v as string)}
            >
              <SelectTrigger id="saved-board-type" aria-label="Board type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BOARD_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {createMutation.isPending ? "Creating…" : "Create board"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
