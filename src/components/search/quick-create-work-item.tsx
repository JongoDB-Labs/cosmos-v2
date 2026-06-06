"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";
import type { Board, OrgMember, WorkItem } from "@/types/models";

export interface PaletteProject {
  id: string;
  key: string;
  name: string;
}

interface QuickCreateWorkItemProps {
  orgId: string;
  orgSlug: string;
  /** Title comes from the command input (reused as the work-item title). */
  title: string;
  /** Prefilled project when the palette is opened on a project route. */
  prefilledProject: PaletteProject | null;
  /** All org projects, fetched lazily by the parent when this view opens. */
  projects: PaletteProject[];
  projectsLoading: boolean;
  onClose: () => void;
}

const TYPES = ["TASK", "STORY", "BUG", "EPIC", "SUBTASK"] as const;
type WorkItemKind = (typeof TYPES)[number];

const fieldClass =
  "h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-ring";

/**
 * In-palette capture form for "Create work item…". The title is driven by the
 * command input (passed in via `title`); this panel owns type / assignee / due
 * date / project. On submit it resolves the project's first board + column,
 * POSTs the item, then navigates to that board so it remounts and refetches.
 */
export function QuickCreateWorkItem({
  orgId,
  orgSlug,
  title,
  prefilledProject,
  projects,
  projectsLoading,
  onClose,
}: QuickCreateWorkItemProps) {
  const router = useRouter();
  const [type, setType] = useState<WorkItemKind>("TASK");
  const [projectId, setProjectId] = useState<string>(
    prefilledProject?.id ?? "",
  );
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [dueDate, setDueDate] = useState<string>("");
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Default the project selection once the project list arrives (when not on a
  // project route there's nothing prefilled).
  useEffect(() => {
    if (!projectId && projects.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

  // Lazily load members for the optional assignee picker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await jsonFetch<OrgMember[]>(
          `/api/v1/orgs/${orgId}/members`,
        );
        if (!cancelled) setMembers(data);
      } catch {
        // Assignee is optional — silently degrade to no list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const selectedProject =
    projects.find((p) => p.id === projectId) ??
    (prefilledProject && prefilledProject.id === projectId
      ? prefilledProject
      : null);

  async function handleSubmit() {
    const trimmed = title.trim();
    if (!trimmed || !projectId || submitting) return;

    setSubmitting(true);
    try {
      // The create API requires a columnKey; resolve the project's first
      // board + first column (falls back to "backlog" from default columns).
      const boards = await jsonFetch<Board[]>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/boards`,
      );
      const firstBoard = boards[0];
      const columnKey = firstBoard?.columns?.[0]?.key ?? "backlog";

      const item = await jsonFetch<WorkItem>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/work-items`,
        {
          method: "POST",
          body: JSON.stringify({
            title: trimmed,
            type,
            columnKey,
            assigneeId: assigneeId || null,
            dueDate: dueDate ? new Date(dueDate).toISOString() : null,
          }),
        },
      );

      onClose();

      const projectKey = selectedProject?.key;
      if (projectKey && firstBoard) {
        router.push(
          `/${orgSlug}/projects/${projectKey}/boards/${firstBoard.id}`,
        );
      } else if (projectKey) {
        router.push(`/${orgSlug}/projects/${projectKey}`);
      }
      void item;
    } catch (err) {
      notifyError(err, "Couldn't create the work item.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  return (
    <div
      className="space-y-3 px-2 py-3"
      onKeyDown={handleKeyDown}
      role="group"
      aria-label="Create work item"
    >
      <p className="px-1 text-xs text-muted-foreground">
        New work item{" "}
        {title.trim() ? (
          <span className="font-medium text-foreground">
            “{title.trim()}”
          </span>
        ) : (
          <span className="italic">— type a title in the box above</span>
        )}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="px-0.5 text-[11px]">Type</Label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as WorkItemKind)}
            className={fieldClass}
            disabled={submitting}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0) + t.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label className="px-0.5 text-[11px]">Project</Label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className={fieldClass}
            disabled={submitting || !!prefilledProject || projectsLoading}
          >
            {prefilledProject && (
              <option value={prefilledProject.id}>
                {prefilledProject.key} · {prefilledProject.name}
              </option>
            )}
            {!prefilledProject && projectsLoading && (
              <option value="">Loading…</option>
            )}
            {!prefilledProject &&
              projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key} · {p.name}
                </option>
              ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label className="px-0.5 text-[11px]">Assignee</Label>
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className={fieldClass}
            disabled={submitting}
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.user?.displayName ?? m.user?.email ?? m.userId}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label className="px-0.5 text-[11px]">Due date</Label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={fieldClass}
            disabled={submitting}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="px-1 text-[11px] text-muted-foreground">
          ⌘↵ to create
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="xs"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            size="xs"
            onClick={() => void handleSubmit()}
            disabled={!title.trim() || !projectId || submitting}
          >
            {submitting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              "Create"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
