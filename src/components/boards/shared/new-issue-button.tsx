"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreateWorkItemDialog } from "@/components/work-items/create-work-item-dialog";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";

interface ProjectRow {
  id: string;
  key: string;
  name: string;
}

/**
 * "New issue" for a board.
 *
 * Every board that shows issues gets the SAME create dialog the Issues page
 * uses, rather than a reduced board-local one. Boards previously had two
 * different creates — a cut-down dialog on Table/Backlog/Timeline/Calendar/RAID
 * with no description, story points, labels or custom fields, and a title-only
 * "Add card" on the Kanban — so which fields you could fill in depended on where
 * you happened to be standing. This is the single affordance.
 *
 * The dialog is project-scoped here (the board fixes the project), and `boardId`
 * points its Status picker at this board's own workflow.
 */
export function NewIssueButton({
  orgId,
  projectId,
  projectKey,
  boardId,
  onCreated,
  label = "New issue",
  variant = "outline",
  initialLabels,
}: {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId?: string;
  onCreated: () => void;
  label?: string;
  variant?: "outline" | "default" | "ghost";
  /** Labels applied to the new issue by default — the RAID log seeds its
   *  category so a new entry doesn't land in "Unclassified" (COSMOS-80). */
  initialLabels?: string[];
}) {
  const [open, setOpen] = useState(false);
  const projectsKey = useOrgQueryKey("projects");

  // The dialog wants a project row so it can label the (locked) Project field.
  // Only fetched once the dialog is opened, and shared with anything else on the
  // page using the same key.
  const { data: projects } = useQuery({
    queryKey: projectsKey,
    queryFn: () => jsonFetch<ProjectRow[]>(`/api/v1/orgs/${orgId}/projects`),
    enabled: open,
    staleTime: 60_000,
  });

  // Fall back to the key as the name rather than rendering an empty picker: the
  // project is fixed and the field is disabled, so the list existing at all
  // matters more than its label. Creation must not wait on a projects GET it
  // doesn't need.
  const projectRows = useMemo(() => {
    const found = projects?.find((p) => p.id === projectId);
    return [found ?? { id: projectId, key: projectKey, name: projectKey }];
  }, [projects, projectId, projectKey]);

  return (
    <>
      <Button size="sm" variant={variant} className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" />
        {label}
      </Button>
      <CreateWorkItemDialog
        orgId={orgId}
        open={open}
        onOpenChange={setOpen}
        projects={projectRows}
        prefilledProjectId={projectId}
        boardId={boardId}
        initialLabels={initialLabels}
        onCreated={onCreated}
      />
    </>
  );
}
