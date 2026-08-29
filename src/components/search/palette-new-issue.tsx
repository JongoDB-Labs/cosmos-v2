"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import {
  CreateWorkItemDialog,
  type CreateProject,
} from "@/components/work-items/create-work-item-dialog";

/**
 * The command palette's "New issue" action (COSMOS-166).
 *
 * ⌘K → "New issue" opens the SAME full-field dialog the "New issue" button on
 * every board opens, rather than a palette-local mini form. That single
 * affordance is the point of `NewIssueButton`: which fields you can fill in
 * must not depend on where you happened to be standing when you started. The
 * palette was the last surface still offering a cut-down create (title, type,
 * assignee, due date — no description, priority, labels, status or custom
 * fields), so ⌘K from the Timeline/Gantt gave you a weaker form than the button
 * three inches above it.
 *
 * Mounted only while open, so the dialog's own React Query hooks (types, custom
 * fields) don't run on every page for a palette nobody has opened.
 */
export function PaletteNewIssue({
  orgId,
  projects,
  prefilledProjectId,
  onClose,
}: {
  orgId: string;
  /** The org's projects, already fetched by the palette. */
  projects: CreateProject[];
  /** Project resolved from the current route, when it names one. */
  prefilledProjectId?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // Prefix key: ["org", slug, "work-items"] matches every project's list.
  const workItemsKey = useOrgQueryKey("work-items");

  return (
    <CreateWorkItemDialog
      orgId={orgId}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      projects={projects}
      prefilledProjectId={prefilledProjectId}
      onCreated={() => {
        // Whatever you hit ⌘K on is still mounted behind the dialog — the Gantt,
        // a board, the Issues list. Invalidate rather than navigate so the new
        // issue turns up in the view you never left.
        void queryClient.invalidateQueries({ queryKey: workItemsKey });
      }}
    />
  );
}
