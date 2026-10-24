"use client";

import { useImperativeHandle, useMemo, useState, type Ref } from "react";
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
  /** The template's sector, which scopes the Type picker. Null = no template. */
  sector: string | null;
}

/** Where a board's right-click landed: the Status column, or the calendar day
 *  (`YYYY-MM-DD`, seeding both planned dates). Seeds only, all editable. */
export interface NewIssueSeed {
  columnKey?: string | null;
  date?: string | null;
}

/** Opens the button's dialog from elsewhere on the board (the right-click
 *  create menu, COSMOS-88), optionally pre-scoped by a {@link NewIssueSeed}. */
export interface NewIssueHandle {
  open: (seed?: NewIssueSeed) => void;
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
  ref,
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
  ref?: Ref<NewIssueHandle>;
}) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<NewIssueSeed>({});

  // The board's right-click menu opens this same dialog rather than a second
  // create surface, so every field and default stays identical (COSMOS-88).
  useImperativeHandle(
    ref,
    () => ({
      open: (next) => {
        setSeed(next ?? {});
        setOpen(true);
      },
    }),
    [],
  );

  // Close the dialog if the board or project it was opened against changes
  // underneath it (COSMOS-63).
  //
  // BoardRenderer switches on `boardType` and passes `boardId`/`projectId` as
  // plain props — no `key` on the view elements or on this button. So navigating
  // from one board to ANOTHER BOARD OF THE SAME TYPE updates this component in
  // place instead of remounting it, and `open` survives. The dialog was left
  // sitting there, still open, still holding base-ui's body scroll lock, now
  // targeting the board you just left: its Status picker is driven by `boardId`,
  // so submitting would file the issue against the previous board's workflow.
  //
  // Fixed here rather than with `key={boardId}` on the five view call sites:
  // keying the whole view would remount the entire board on every navigation,
  // throwing away scroll position, filters and loaded data to solve a dialog
  // problem — and it would need remembering at each new call site.
  //
  // This is React's documented "adjust state when a prop changes" pattern: a
  // render-phase setState on this same component, which re-renders immediately
  // without committing the stale UI to the screen. An effect would paint the
  // orphaned dialog for a frame first.
  const scope = `${projectId}\u0000${boardId ?? ""}`;
  const [openedForScope, setOpenedForScope] = useState(scope);
  if (openedForScope !== scope) {
    setOpenedForScope(scope);
    if (open) setOpen(false);
  }

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
    // `sector: null` on the fallback is deliberate — before the GET resolves we
    // do not know the sector, and guessing would hide types. Null means "show
    // the whole catalogue", so the picker only ever narrows once it is certain.
    return [
      found ?? { id: projectId, key: projectKey, name: projectKey, sector: null },
    ];
  }, [projects, projectId, projectKey]);

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        className="gap-1.5"
        onClick={() => {
          setSeed({});
          setOpen(true);
        }}
      >
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
        initialColumnKey={seed.columnKey}
        initialStartDate={seed.date}
        initialDueDate={seed.date}
        onCreated={onCreated}
      />
    </>
  );
}
