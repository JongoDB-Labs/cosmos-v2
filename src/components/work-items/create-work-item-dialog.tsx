"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";
import type { Board, OrgMember } from "@/types/models";

const TYPES = ["TASK", "STORY", "BUG", "EPIC", "SUBTASK"] as const;
const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

const fieldClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-ring";

export interface CreateProject {
  id: string;
  key: string;
  name: string;
}

/**
 * Full-field "New issue" dialog (Jira-style): every common field is available
 * at creation — title, project, type, priority, assignee, story points, due
 * date, description, labels — not just a title. Resolves the project's first
 * board + column for the required columnKey; the work-items POST already
 * accepts all of these fields. onCreated lets the caller refetch its list.
 */
export function CreateWorkItemDialog({
  orgId,
  open,
  onOpenChange,
  projects,
  prefilledProjectId,
  onCreated,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: CreateProject[];
  prefilledProjectId?: string;
  onCreated?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(prefilledProjectId ?? "");
  const [type, setType] = useState<(typeof TYPES)[number]>("TASK");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("MEDIUM");
  const [assigneeId, setAssigneeId] = useState("");
  const [storyPoints, setStoryPoints] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState("");
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Reset the form each time the dialog opens; default the project.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle("");
      setType("TASK");
      setPriority("MEDIUM");
      setAssigneeId("");
      setStoryPoints("");
      setDueDate("");
      setDescription("");
      setLabels("");
      setProjectId(prefilledProjectId ?? projects[0]?.id ?? "");
    }
  }, [open, prefilledProjectId, projects]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`);
        if (!cancelled) setMembers(data);
      } catch {
        /* assignee optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, orgId]);

  async function handleSubmit() {
    const trimmed = title.trim();
    if (!trimmed || !projectId || submitting) return;
    setSubmitting(true);
    try {
      // The create API requires a columnKey — resolve the project's first board
      // + first column (falls back to "backlog").
      const boards = await jsonFetch<Board[]>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/boards`,
      );
      const columnKey = boards[0]?.columns?.[0]?.key ?? "backlog";
      const tags = labels
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const points = storyPoints.trim() === "" ? undefined : Number(storyPoints);

      await jsonFetch(`/api/v1/orgs/${orgId}/projects/${projectId}/work-items`, {
        method: "POST",
        body: JSON.stringify({
          title: trimmed,
          type,
          columnKey,
          priority,
          assigneeId: assigneeId || null,
          description: description.trim() || null,
          dueDate: dueDate ? new Date(dueDate).toISOString() : null,
          tags: tags.length ? tags : undefined,
          ...(points != null && Number.isFinite(points) ? { storyPoints: points } : {}),
        }),
      });
      toast.success(`Created "${trimmed}"`);
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      notifyError(err, "Couldn't create the issue.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>
            Fill in as much as you like — only a title and project are required.
          </DialogDescription>
        </DialogHeader>
        <div
          className="space-y-3"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="ci-title">Title</Label>
            <Input
              id="ci-title"
              autoFocus
              placeholder="Summary of the work…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Project</Label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className={fieldClass}
                disabled={submitting || !!prefilledProjectId}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
                className={fieldClass}
                disabled={submitting}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {titleCase(t)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Priority</Label>
              <select
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value as (typeof PRIORITIES)[number])
                }
                className={fieldClass}
                disabled={submitting}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {titleCase(p)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Assignee</Label>
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
              <Label className="text-xs">Story points</Label>
              <Input
                type="number"
                min={0}
                placeholder="—"
                value={storyPoints}
                onChange={(e) => setStoryPoints(e.target.value)}
                disabled={submitting}
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Due date</Label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className={fieldClass}
                disabled={submitting}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="ci-desc" className="text-xs">
              Description
            </Label>
            <Textarea
              id="ci-desc"
              rows={3}
              placeholder="Details, acceptance criteria…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="ci-labels" className="text-xs">
              Labels
            </Label>
            <Input
              id="ci-labels"
              placeholder="comma, separated, labels"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              disabled={submitting}
              className="h-9"
            />
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            ⌘↵ to create
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleSubmit()}
              disabled={!title.trim() || !projectId || submitting}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create issue"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
