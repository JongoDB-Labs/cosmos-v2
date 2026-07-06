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
import { useCustomFields } from "@/hooks/use-custom-fields";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import {
  CustomFieldInput,
  isCustomFieldEmpty,
  isRenderableCustomField,
} from "@/components/work-items/custom-field-input";
import type { Board, OrgMember } from "@/types/models";

const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/**
 * Pick the default type to preselect: the project's "task" type if present
 * (built-in keys end with `.task`), else the first type. Returns "" when the
 * list is empty (still loading).
 */
function defaultTypeId(types: { id: string; key: string }[]): string {
  if (types.length === 0) return "";
  const task = types.find((t) => t.key === "task" || t.key.endsWith(".task"));
  return (task ?? types[0]).id;
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
  const [workItemTypeId, setWorkItemTypeId] = useState("");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("MEDIUM");
  // Multi-assign (FR 1d38496a): full set; first pick becomes the primary.
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [storyPoints, setStoryPoints] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState("");
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Per-item custom-field values, keyed by CustomField.key. Defs are loaded for
  // the currently-selected project (org-wide defs always included).
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  const [showCustomErrors, setShowCustomErrors] = useState(false);
  const { fields: customFields } = useCustomFields(orgId, projectId || undefined);
  const renderableFields = customFields.filter(isRenderableCustomField);
  // The org's ACTUAL types (built-ins + custom) so the Type picker offers e.g.
  // a "Feature" type. We submit the selected type's id (workItemTypeId) so the
  // server doesn't have to re-derive a sector-prefixed key — which never
  // resolves bare custom keys like "feature".
  const { types: workItemTypes } = useWorkItemTypes(orgId);

  // Reset the form each time the dialog opens; default the project.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle("");
      setPriority("MEDIUM");
      setAssigneeIds([]);
      setStoryPoints("");
      setDueDate("");
      setDescription("");
      setLabels("");
      setCustomValues({});
      setShowCustomErrors(false);
      setProjectId(prefilledProjectId ?? projects[0]?.id ?? "");
    }
  }, [open, prefilledProjectId, projects]);

  // Default / repair the Type selection once the types load (and re-default
  // when the dialog reopens). Keep a valid selection if one is already chosen.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorkItemTypeId((prev) =>
      prev && workItemTypes.some((t) => t.id === prev)
        ? prev
        : defaultTypeId(workItemTypes),
    );
  }, [open, workItemTypes]);

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

    // Enforce required custom fields before hitting the API.
    const missing = renderableFields.filter(
      (f) => f.required && isCustomFieldEmpty(f, customValues[f.key]),
    );
    if (missing.length > 0) {
      setShowCustomErrors(true);
      toast.error(
        `Fill in required field${missing.length > 1 ? "s" : ""}: ${missing
          .map((f) => f.name)
          .join(", ")}`,
      );
      return;
    }

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
      // Collect non-empty custom-field values into the POST body's customFields.
      const customFieldsBody: Record<string, unknown> = {};
      for (const f of renderableFields) {
        const v = customValues[f.key];
        if (!isCustomFieldEmpty(f, v)) customFieldsBody[f.key] = v;
      }
      const points = storyPoints.trim() === "" ? undefined : Number(storyPoints);
      // The server requires whole-number story points (z.number().int()); a
      // fractional entry would otherwise round-trip to a generic 400 with no
      // hint as to the cause. Catch it here with a specific, actionable message.
      if (points != null && (!Number.isInteger(points) || points < 0)) {
        toast.error("Story points must be a whole number.");
        setSubmitting(false);
        return;
      }

      await jsonFetch(`/api/v1/orgs/${orgId}/projects/${projectId}/work-items`, {
        method: "POST",
        body: JSON.stringify({
          title: trimmed,
          ...(workItemTypeId ? { workItemTypeId } : { type: "TASK" }),
          columnKey,
          priority,
          ...(assigneeIds.length ? { assigneeIds } : {}),
          description: description.trim() || null,
          dueDate: dueDate ? new Date(dueDate).toISOString() : null,
          tags: tags.length ? tags : undefined,
          ...(points != null && Number.isFinite(points) ? { storyPoints: points } : {}),
          ...(Object.keys(customFieldsBody).length > 0
            ? { customFields: customFieldsBody }
            : {}),
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
                value={workItemTypeId}
                onChange={(e) => setWorkItemTypeId(e.target.value)}
                className={fieldClass}
                disabled={submitting || workItemTypes.length === 0}
              >
                {workItemTypes.length === 0 && (
                  <option value="">Loading…</option>
                )}
                {workItemTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
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
              <Label className="text-xs">Assignees</Label>
              {/* Multi-assign (FR 1d38496a): check any number; first checked
                  becomes the primary assignee. */}
              <div className="max-h-28 overflow-y-auto rounded-md border border-[var(--border)] p-1.5">
                {members.map((m) => (
                  <label
                    key={m.userId}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={assigneeIds.includes(m.userId)}
                      disabled={submitting}
                      onChange={(e) =>
                        setAssigneeIds((prev) =>
                          e.target.checked
                            ? [...prev, m.userId]
                            : prev.filter((id) => id !== m.userId),
                        )
                      }
                    />
                    {m.user?.displayName ?? m.user?.email ?? m.userId}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Story points</Label>
              <Input
                type="number"
                min={0}
                step={1}
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

          {/* Custom fields defined for this project (org-wide + project-scoped).
              Bindings to specific work-item types are honored on the detail
              sheet, where the resolved type is known; at create time the type
              is resolved server-side, so all renderable fields are shown. */}
          {renderableFields.length > 0 && (
            <div className="grid grid-cols-2 gap-3 border-t pt-3">
              {renderableFields.map((f) => (
                <CustomFieldInput
                  key={f.id}
                  field={f}
                  value={customValues[f.key]}
                  onChange={(v) =>
                    setCustomValues((prev) => ({ ...prev, [f.key]: v }))
                  }
                  disabled={submitting}
                  showRequiredMark
                  invalid={
                    showCustomErrors &&
                    f.required &&
                    isCustomFieldEmpty(f, customValues[f.key])
                  }
                />
              ))}
            </div>
          )}
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
              disabled={!title.trim() || !projectId || !workItemTypeId || submitting}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create issue"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
