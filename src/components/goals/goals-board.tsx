"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Target,
  Plus,
  Pencil,
  Trash2,
  Link2,
  X,
  AlertTriangle,
  Loader2,
  Calendar,
  Gauge,
} from "lucide-react";

// ── Types (model the actual API responses; @/types/models has no Goal yet) ──

type GoalStatus =
  | "PLANNED"
  | "ON_TRACK"
  | "AT_RISK"
  | "OFF_TRACK"
  | "ACHIEVED";
type GoalProgressMode = "MANUAL" | "AUTO";
type GoalLinkKind = "WORK_ITEM" | "OBJECTIVE";

interface GoalLink {
  id: string;
  goalId: string;
  kind: GoalLinkKind;
  workItemId: string | null;
  objectiveId: string | null;
  createdAt: string;
}

interface Goal {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  progress: number;
  progressMode: GoalProgressMode;
  targetDate: string | null;
  ownerId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  links: GoalLink[];
}

interface WorkItemLite {
  id: string;
  title: string;
  ticketNumber: number;
  columnKey: string;
}

interface ObjectiveLite {
  id: string;
  title: string;
  progress: number;
}

interface GoalsBoardProps {
  orgId: string;
  projectId: string;
}

// ── Display maps ──

const STATUS_OPTIONS: { value: GoalStatus; label: string }[] = [
  { value: "PLANNED", label: "Planned" },
  { value: "ON_TRACK", label: "On track" },
  { value: "AT_RISK", label: "At risk" },
  { value: "OFF_TRACK", label: "Off track" },
  { value: "ACHIEVED", label: "Achieved" },
];

const STATUS_VARIANT: Record<GoalStatus, BadgeVariant> = {
  PLANNED: "neutral",
  ON_TRACK: "progress",
  AT_RISK: "review",
  OFF_TRACK: "critical",
  ACHIEVED: "done",
};

const PROGRESS_MODE_OPTIONS: { value: GoalProgressMode; label: string }[] = [
  { value: "MANUAL", label: "Manual" },
  { value: "AUTO", label: "Auto (roll up from links)" },
];

function statusLabel(status: GoalStatus): string {
  return STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Form state ──

interface GoalFormData {
  title: string;
  description: string;
  status: GoalStatus;
  targetDate: string; // yyyy-mm-dd (from <input type="date">)
  progressMode: GoalProgressMode;
}

const emptyForm: GoalFormData = {
  title: "",
  description: "",
  status: "PLANNED",
  targetDate: "",
  progressMode: "MANUAL",
};

function formFromGoal(g: Goal): GoalFormData {
  return {
    title: g.title,
    description: g.description ?? "",
    status: g.status,
    targetDate: g.targetDate ? g.targetDate.slice(0, 10) : "",
    progressMode: g.progressMode,
  };
}

/** date-only string → ISO datetime (the API expects z.string().datetime()). */
function dateInputToIso(value: string): string | null {
  const t = value.trim();
  if (!t) return null;
  const d = new Date(`${t}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formToBody(form: GoalFormData) {
  return {
    title: form.title.trim(),
    description: form.description.trim() || null,
    status: form.status,
    targetDate: dateInputToIso(form.targetDate),
    progressMode: form.progressMode,
  };
}

export function GoalsBoard({ orgId, projectId }: GoalsBoardProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const goalsApi = `${apiBase}/goals`;

  const goalsKey = useOrgQueryKey("goals", projectId);
  const {
    data: goals = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: goalsKey,
    queryFn: () => jsonFetch<Goal[]>(goalsApi),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [deletingGoal, setDeletingGoal] = useState<Goal | null>(null);
  const [linkingGoal, setLinkingGoal] = useState<Goal | null>(null);
  const [form, setForm] = useState<GoalFormData>(emptyForm);

  const invalidate = [["goals", projectId]];

  const createMutation = useOrgMutation<Goal, Error, GoalFormData>({
    mutationFn: (data) =>
      jsonFetch(goalsApi, { method: "POST", body: JSON.stringify(formToBody(data)) }),
    invalidate,
    onSuccess: () => {
      setCreateOpen(false);
      setForm(emptyForm);
    },
    onError: (err) => notifyError(err, "Couldn't create the goal."),
  });

  const updateMutation = useOrgMutation<Goal, Error, { id: string; data: GoalFormData }>({
    mutationFn: ({ id, data }) =>
      jsonFetch(`${goalsApi}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(formToBody(data)),
      }),
    invalidate,
    onSuccess: () => setEditingGoal(null),
    onError: (err) => notifyError(err, "Couldn't update the goal."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${goalsApi}/${id}`, { method: "DELETE" }),
    invalidate,
    onSuccess: () => setDeletingGoal(null),
    onError: (err) => notifyError(err, "Couldn't delete the goal."),
  });

  const submitting = createMutation.isPending || updateMutation.isPending;

  function openCreate() {
    setForm(emptyForm);
    setCreateOpen(true);
  }

  function openEdit(goal: Goal) {
    setForm(formFromGoal(goal));
    setEditingGoal(goal);
  }

  function handleCreate() {
    if (!form.title.trim()) return;
    createMutation.mutate(form);
  }

  function handleEdit() {
    if (!editingGoal || !form.title.trim()) return;
    updateMutation.mutate({ id: editingGoal.id, data: form });
  }

  // Keep the link dialog's goal in sync with refetched data so chips update
  // after a link is added/removed.
  const linkingGoalLive = useMemo(
    () => (linkingGoal ? goals.find((g) => g.id === linkingGoal.id) ?? linkingGoal : null),
    [linkingGoal, goals],
  );

  if (isLoading) return <GoalsBoardSkeleton />;

  if (isError) {
    return (
      <div className="mx-auto max-w-3xl p-4">
        <LoadError
          onRetry={() => {
            void refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--text-muted)]">
          {goals.length} goal{goals.length !== 1 ? "s" : ""}
        </p>
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          New goal
        </Button>
      </div>

      {goals.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No goals yet"
          description="Set high-level goals for this project and link them to work items or objectives to track progress."
          action={
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              New goal
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              onEdit={() => openEdit(goal)}
              onDelete={() => setDeletingGoal(goal)}
              onLink={() => setLinkingGoal(goal)}
            />
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New goal</DialogTitle>
            <DialogDescription>
              Define a goal for this project. Use Auto progress to roll up from
              linked work items and objectives.
            </DialogDescription>
          </DialogHeader>
          <GoalForm form={form} setForm={setForm} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={submitting || !form.title.trim()}>
              {createMutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={editingGoal !== null}
        onOpenChange={(open) => {
          if (!open) setEditingGoal(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit goal</DialogTitle>
            <DialogDescription>Update this goal&apos;s details.</DialogDescription>
          </DialogHeader>
          <GoalForm form={form} setForm={setForm} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingGoal(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={submitting || !form.title.trim()}>
              {updateMutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={deletingGoal !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingGoal(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" />
              Delete goal
            </DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium">{deletingGoal?.title}</span> and its links.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingGoal(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deletingGoal) deleteMutation.mutate(deletingGoal.id);
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Link dialog */}
      <LinkDialog
        apiBase={apiBase}
        goalsApi={goalsApi}
        projectId={projectId}
        goal={linkingGoalLive}
        open={linkingGoal !== null}
        onClose={() => setLinkingGoal(null)}
        invalidate={invalidate}
      />
    </div>
  );
}

// ── Goal card ──

function GoalCard({
  goal,
  onEdit,
  onDelete,
  onLink,
}: {
  goal: Goal;
  onEdit: () => void;
  onDelete: () => void;
  onLink: () => void;
}) {
  const target = formatDate(goal.targetDate);
  const linkCount = goal.links.length;

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text)]">{goal.title}</span>
            <Badge variant={STATUS_VARIANT[goal.status]}>{statusLabel(goal.status)}</Badge>
          </div>
          {goal.description && (
            <p className="line-clamp-2 text-sm text-[var(--text-muted)]">{goal.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-xs" onClick={onLink} title="Link items">
            <Link2 className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onEdit} title="Edit goal">
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onDelete} title="Delete goal">
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1">
            <Gauge className="size-3" />
            {goal.progressMode === "AUTO" ? "Auto" : "Manual"}
          </span>
          <span className="font-medium text-[var(--text)]">{goal.progress}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--primary-tint)]">
          <div
            className="h-full rounded-full bg-[var(--primary)] transition-all"
            style={{ width: `${Math.min(100, Math.max(0, goal.progress))}%` }}
          />
        </div>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
        {target && (
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="size-3.5" />
            {target}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <Link2 className="size-3.5" />
          {linkCount} linked item{linkCount !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}

// ── Goal form ──

function GoalForm({
  form,
  setForm,
}: {
  form: GoalFormData;
  setForm: React.Dispatch<React.SetStateAction<GoalFormData>>;
}) {
  return (
    <div className="flex flex-col gap-4 py-2">
      <FormField label="Title" required>
        {(p) => (
          <Input
            {...p}
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="e.g. Ship the new onboarding flow"
          />
        )}
      </FormField>

      <FormField label="Description">
        {(p) => (
          <Textarea
            {...p}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="What does success look like?"
          />
        )}
      </FormField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" id="goal-status-label">
            Status
          </label>
          <Select
            value={form.status}
            onValueChange={(val) =>
              setForm((f) => ({ ...f, status: (val as GoalStatus) ?? "PLANNED" }))
            }
          >
            <SelectTrigger className="w-full" aria-labelledby="goal-status-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" id="goal-mode-label">
            Progress
          </label>
          <Select
            value={form.progressMode}
            onValueChange={(val) =>
              setForm((f) => ({ ...f, progressMode: (val as GoalProgressMode) ?? "MANUAL" }))
            }
          >
            <SelectTrigger className="w-full" aria-labelledby="goal-mode-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROGRESS_MODE_OPTIONS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <FormField label="Target date">
        {(p) => (
          <Input
            {...p}
            type="date"
            value={form.targetDate}
            onChange={(e) => setForm((f) => ({ ...f, targetDate: e.target.value }))}
          />
        )}
      </FormField>
    </div>
  );
}

// ── Link dialog ──

function LinkDialog({
  apiBase,
  goalsApi,
  projectId,
  goal,
  open,
  onClose,
  invalidate,
}: {
  apiBase: string;
  goalsApi: string;
  projectId: string;
  goal: Goal | null;
  open: boolean;
  onClose: () => void;
  invalidate: unknown[][];
}) {
  const [kind, setKind] = useState<GoalLinkKind>("WORK_ITEM");
  const [selectedId, setSelectedId] = useState<string>("");

  const workItemsKey = useOrgQueryKey("work-items", "link-picker", projectId);
  const objectivesKey = useOrgQueryKey("objectives", "link-picker", projectId);

  const { data: workItems = [] } = useQuery({
    queryKey: workItemsKey,
    queryFn: () => jsonFetch<WorkItemLite[]>(`${apiBase}/work-items`),
    enabled: open,
  });
  const { data: objectives = [] } = useQuery({
    queryKey: objectivesKey,
    queryFn: () => jsonFetch<ObjectiveLite[]>(`${apiBase}/objectives`),
    enabled: open,
  });

  const linkedWorkItemIds = useMemo(
    () => new Set(goal?.links.filter((l) => l.kind === "WORK_ITEM").map((l) => l.workItemId)),
    [goal],
  );
  const linkedObjectiveIds = useMemo(
    () => new Set(goal?.links.filter((l) => l.kind === "OBJECTIVE").map((l) => l.objectiveId)),
    [goal],
  );

  const addLinkMutation = useOrgMutation<
    GoalLink,
    Error,
    { goalId: string; kind: GoalLinkKind; targetId: string }
  >({
    mutationFn: ({ goalId, kind: k, targetId }) =>
      jsonFetch(`${goalsApi}/${goalId}/links`, {
        method: "POST",
        body: JSON.stringify(
          k === "WORK_ITEM"
            ? { kind: k, workItemId: targetId }
            : { kind: k, objectiveId: targetId },
        ),
      }),
    invalidate,
    onSuccess: () => setSelectedId(""),
    onError: (err) => notifyError(err, "Couldn't add the link."),
  });

  const removeLinkMutation = useOrgMutation<
    unknown,
    Error,
    { goalId: string; linkId: string }
  >({
    mutationFn: ({ goalId, linkId }) =>
      jsonFetch(`${goalsApi}/${goalId}/links/${linkId}`, { method: "DELETE" }),
    invalidate,
    onError: (err) => notifyError(err, "Couldn't remove the link."),
  });

  function handleAdd() {
    if (!goal || !selectedId) return;
    addLinkMutation.mutate({ goalId: goal.id, kind, targetId: selectedId });
  }

  const workItemById = useMemo(
    () => new Map(workItems.map((w) => [w.id, w])),
    [workItems],
  );
  const objectiveById = useMemo(
    () => new Map(objectives.map((o) => [o.id, o])),
    [objectives],
  );

  const availableWorkItems = workItems.filter((w) => !linkedWorkItemIds.has(w.id));
  const availableObjectives = objectives.filter((o) => !linkedObjectiveIds.has(o.id));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setSelectedId("");
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link items</DialogTitle>
          <DialogDescription>
            Attach work items or objectives to{" "}
            <span className="font-medium">{goal?.title}</span>. Auto goals roll up
            progress from these.
          </DialogDescription>
        </DialogHeader>

        {/* Existing links */}
        <div className="flex flex-col gap-2 py-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">Linked</span>
          {goal && goal.links.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {goal.links.map((link) => {
                let label: string;
                if (link.kind === "WORK_ITEM") {
                  const item = link.workItemId ? workItemById.get(link.workItemId) : undefined;
                  label = item ? `#${item.ticketNumber} ${item.title}` : "Work item (removed)";
                } else {
                  const obj = link.objectiveId ? objectiveById.get(link.objectiveId) : undefined;
                  label = obj ? obj.title : "Objective (removed)";
                }
                return (
                  <span
                    key={link.id}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 text-xs text-[var(--text)]"
                  >
                    <Link2 className="size-3 shrink-0 text-[var(--text-muted)]" />
                    <span className="truncate">{label}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded-full text-[var(--text-muted)] hover:text-[var(--text)]"
                      title="Remove link"
                      disabled={removeLinkMutation.isPending}
                      onClick={() =>
                        removeLinkMutation.mutate({ goalId: goal.id, linkId: link.id })
                      }
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">No links yet.</p>
          )}
        </div>

        {/* Add a link */}
        <div className="flex flex-col gap-3 border-t border-[var(--border)] pt-3">
          <span className="text-xs font-medium text-[var(--text-muted)]">Add a link</span>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" id="link-kind-label">
                Type
              </label>
              <Select
                value={kind}
                onValueChange={(val) => {
                  setKind((val as GoalLinkKind) ?? "WORK_ITEM");
                  setSelectedId("");
                }}
              >
                <SelectTrigger className="w-full" aria-labelledby="link-kind-label">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="WORK_ITEM">Work item</SelectItem>
                  <SelectItem value="OBJECTIVE">Objective</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" id="link-target-label">
                {kind === "WORK_ITEM" ? "Work item" : "Objective"}
              </label>
              <Select
                value={selectedId}
                onValueChange={(val) => setSelectedId(val ?? "")}
              >
                <SelectTrigger className="w-full" aria-labelledby="link-target-label">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {kind === "WORK_ITEM" ? (
                    availableWorkItems.length > 0 ? (
                      availableWorkItems.map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          {`#${w.ticketNumber} ${w.title}`}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="__none" disabled>
                        No work items available
                      </SelectItem>
                    )
                  ) : availableObjectives.length > 0 ? (
                    availableObjectives.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.title}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__none" disabled>
                      No objectives available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={handleAdd}
              disabled={!selectedId || selectedId === "__none" || addLinkMutation.isPending}
            >
              {addLinkMutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              <Plus className="size-4" />
              Add link
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setSelectedId("");
              onClose();
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Skeleton ──

function GoalsBoardSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)] p-4"
          >
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-16" />
            </div>
            <Skeleton className="h-1.5 w-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}
