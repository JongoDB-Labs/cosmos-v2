"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Flag, Plus, Pencil, Trash2, Link2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { cn } from "@/lib/utils";
import type { WorkItem, OrgMember } from "@/types/models";

interface MilestonesTimelineProps {
  orgId: string;
  projectId: string;
}

type MilestoneStatus = "UPCOMING" | "IN_PROGRESS" | "COMPLETED" | "MISSED";

interface MilestoneLink {
  id: string;
  milestoneId: string;
  workItemId: string;
  createdAt: string;
}

interface Milestone {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  description: string | null;
  dueDate: string;
  status: MilestoneStatus;
  autoStatus: boolean;
  completedAt: string | null;
  ownerId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  links: MilestoneLink[];
}

const STATUS_META: Record<
  MilestoneStatus,
  { label: string; badge: BadgeVariant; dot: string; line: string }
> = {
  UPCOMING: {
    label: "Upcoming",
    badge: "neutral",
    dot: "var(--text-muted)",
    line: "var(--text-muted)",
  },
  IN_PROGRESS: {
    label: "In progress",
    badge: "progress",
    dot: "var(--primary)",
    line: "var(--primary)",
  },
  COMPLETED: {
    label: "Completed",
    badge: "done",
    dot: "var(--status-done)",
    line: "var(--status-done)",
  },
  MISSED: {
    label: "Missed",
    badge: "critical",
    dot: "var(--status-critical)",
    line: "var(--status-critical)",
  },
};

const STATUS_OPTIONS: MilestoneStatus[] = [
  "UPCOMING",
  "IN_PROGRESS",
  "COMPLETED",
  "MISSED",
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** ISO date string (YYYY-MM-DD) suitable for a <input type="date">. */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** Convert a date-input value (YYYY-MM-DD) to a full ISO datetime. */
function fromDateInput(value: string): string {
  // Anchor to midday UTC so the displayed day doesn't drift across timezones.
  return new Date(`${value}T12:00:00.000Z`).toISOString();
}

export function MilestonesTimeline({ orgId, projectId }: MilestonesTimelineProps) {
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const milestonesKey = useOrgQueryKey("milestones", projectId);
  const membersKey = useOrgQueryKey("members");

  const milestonesQ = useQuery({
    queryKey: milestonesKey,
    queryFn: () => jsonFetch<Milestone[]>(`${basePath}/milestones`),
  });
  const membersQ = useQuery({
    queryKey: membersKey,
    queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
  });

  const milestones = useMemo(
    () =>
      [...(milestonesQ.data ?? [])].sort(
        (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
      ),
    [milestonesQ.data],
  );
  const ownerName = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQ.data ?? []) {
      map.set(m.userId, m.user?.displayName ?? m.user?.email ?? "Unknown");
    }
    return map;
  }, [membersQ.data]);

  // Dialog / panel state
  const [createOpen, setCreateOpen] = useState(false);
  const [editMilestone, setEditMilestone] = useState<Milestone | null>(null);
  const [linkMilestone, setLinkMilestone] = useState<Milestone | null>(null);

  // Deep-link: `?open=<id>` (e.g. a click from the Release Timeline) opens that
  // milestone's edit dialog once loaded — a reference from any view reaches the
  // SAME editable surface (COSMOS-45). Fires once so a manual close stays closed.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || typeof window === "undefined") return;
    const id = new URLSearchParams(window.location.search).get("open");
    if (!id) {
      deepLinkHandled.current = true;
      return;
    }
    const target = milestones.find((m) => m.id === id);
    if (target) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditMilestone(target);
      deepLinkHandled.current = true;
    }
  }, [milestones]);

  const createMutation = useOrgMutation<Milestone, Error, CreatePayload>({
    mutationFn: (payload) =>
      jsonFetch<Milestone>(`${basePath}/milestones`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    invalidate: [["milestones", projectId]],
    onSuccess: () => setCreateOpen(false),
  });

  const updateMutation = useOrgMutation<
    Milestone,
    Error,
    { id: string; patch: UpdatePayload }
  >({
    mutationFn: ({ id, patch }) =>
      jsonFetch<Milestone>(`${basePath}/milestones/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    invalidate: [["milestones", projectId]],
    onSuccess: () => setEditMilestone(null),
  });

  const deleteMutation = useOrgMutation<{ id: string }, Error, string>({
    mutationFn: (id) =>
      jsonFetch<{ id: string }>(`${basePath}/milestones/${id}`, {
        method: "DELETE",
      }),
    invalidate: [["milestones", projectId]],
  });

  function handleDelete(m: Milestone) {
    if (!confirm(`Delete milestone "${m.title}"? This can't be undone.`)) return;
    deleteMutation.mutate(m.id);
  }

  if (milestonesQ.isLoading) return <MilestonesSkeleton />;

  if (milestonesQ.error) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <p className="text-sm font-medium text-[var(--status-critical-text)]">
            Failed to load milestones
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {milestonesQ.error instanceof Error
              ? milestonesQ.error.message
              : "Unknown error"}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => milestonesQ.refetch()}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">Milestones</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Key dates and deliverables across this project.
          </p>
        </div>
        {milestones.length > 0 && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New milestone
          </Button>
        )}
      </div>

      {milestones.length === 0 ? (
        <EmptyState
          icon={Flag}
          title="No milestones yet"
          description="Track key dates and deliverables. Create a milestone to plot it on the timeline."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              New milestone
            </Button>
          }
        />
      ) : (
        <>
          <MiniAxis milestones={milestones} />
          <MilestoneList
            milestones={milestones}
            ownerName={ownerName}
            onEdit={setEditMilestone}
            onDelete={handleDelete}
            onLink={setLinkMilestone}
          />
        </>
      )}

      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={(payload) => createMutation.mutate(payload)}
        submitting={createMutation.isPending}
      />

      {editMilestone && (
        <EditDialog
          milestone={editMilestone}
          onOpenChange={(open) => {
            if (!open) setEditMilestone(null);
          }}
          onSubmit={(patch) =>
            updateMutation.mutate({ id: editMilestone.id, patch })
          }
          submitting={updateMutation.isPending}
        />
      )}

      {linkMilestone && (
        <LinkDialog
          milestone={linkMilestone}
          basePath={basePath}
          projectId={projectId}
          onOpenChange={(open) => {
            if (!open) setLinkMilestone(null);
          }}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Mini horizontal axis — every milestone plotted by dueDate, plus a "today"
 * marker. Purely visual orientation; the list below is the primary surface.
 * ------------------------------------------------------------------------- */

function MiniAxis({ milestones }: { milestones: Milestone[] }) {
  // Capture "now" once on mount so the axis is stable across re-renders
  // (calling Date.now() during render is an impurity).
  const [now] = useState(() => Date.now());

  const { min, span, todayPct } = useMemo(() => {
    const times = milestones.map((m) => new Date(m.dueDate).getTime());
    const lo = Math.min(...times, now);
    const hi = Math.max(...times, now);
    // Avoid a zero span (single milestone or all same day).
    const range = Math.max(hi - lo, 1);
    return {
      min: lo,
      span: range,
      todayPct: ((now - lo) / range) * 100,
    };
  }, [milestones, now]);

  function pct(iso: string): number {
    return ((new Date(iso).getTime() - min) / span) * 100;
  }

  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="relative h-16">
        {/* Baseline */}
        <div
          className="absolute top-8 right-0 left-0 h-px"
          style={{ backgroundColor: "var(--border)" }}
        />

        {/* Today marker */}
        {todayPct >= 0 && todayPct <= 100 && (
          <div
            className="absolute top-2 bottom-2 w-px"
            style={{
              left: `${todayPct}%`,
              backgroundColor: "var(--primary)",
            }}
            aria-hidden
          >
            <span className="absolute -top-1 left-1 text-[10px] font-medium whitespace-nowrap text-[var(--primary)]">
              Today
            </span>
          </div>
        )}

        {/* Milestone flags */}
        {milestones.map((m) => {
          const meta = STATUS_META[m.status];
          return (
            <div
              key={m.id}
              className="group absolute top-8 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${pct(m.dueDate)}%` }}
            >
              <div
                className="size-3 rounded-full ring-2 ring-[var(--surface)]"
                style={{ backgroundColor: meta.dot }}
                title={`${m.title} — ${formatDate(m.dueDate)} (${meta.label})`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Vertical list with a left rail + status dots.
 * ------------------------------------------------------------------------- */

function MilestoneList({
  milestones,
  ownerName,
  onEdit,
  onDelete,
  onLink,
}: {
  milestones: Milestone[];
  ownerName: Map<string, string>;
  onEdit: (m: Milestone) => void;
  onDelete: (m: Milestone) => void;
  onLink: (m: Milestone) => void;
}) {
  return (
    <ol className="relative space-y-3 pl-6">
      {/* Left rail */}
      <span
        className="absolute top-2 bottom-2 left-[5px] w-px"
        style={{ backgroundColor: "var(--border)" }}
        aria-hidden
      />
      {milestones.map((m) => {
        const meta = STATUS_META[m.status];
        return (
          <li key={m.id} className="relative">
            {/* Rail dot */}
            <span
              className="absolute top-4 -left-[19px] size-2.5 rounded-full ring-2 ring-[var(--surface)]"
              style={{ backgroundColor: meta.dot }}
              aria-hidden
            />
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:border-[var(--primary)]/40">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-medium text-[var(--text)]">
                      {m.title}
                    </h3>
                    <Badge variant={meta.badge}>{meta.label}</Badge>
                    {m.autoStatus && (
                      <span className="text-[10px] tracking-wide text-[var(--text-muted)] uppercase">
                        auto
                      </span>
                    )}
                  </div>
                  {m.description && (
                    <p className="mt-1 text-sm text-[var(--text-muted)]">
                      {m.description}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
                    <span>Due {formatDate(m.dueDate)}</span>
                    <span>
                      {m.links.length}{" "}
                      {m.links.length === 1 ? "linked item" : "linked items"}
                    </span>
                    {m.ownerId && (
                      <span>
                        Owner: {ownerName.get(m.ownerId) ?? "Unknown"}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Link work items"
                    onClick={() => onLink(m)}
                  >
                    <Link2 className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Edit milestone"
                    onClick={() => onEdit(m)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete milestone"
                    onClick={() => onDelete(m)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ----------------------------------------------------------------------------
 * Create dialog
 * ------------------------------------------------------------------------- */

interface CreatePayload {
  title: string;
  description: string | null;
  dueDate: string;
  autoStatus: boolean;
}

function CreateDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: CreatePayload) => void;
  submitting: boolean;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [autoStatus, setAutoStatus] = useState(true);

  // Reset fields whenever the dialog is (re)opened.
  function handleOpenChange(next: boolean) {
    if (next) {
      setTitle("");
      setDescription("");
      setDueDate("");
      setAutoStatus(true);
    }
    onOpenChange(next);
  }

  function submit() {
    if (!title.trim() || !dueDate) return;
    onSubmit({
      title: title.trim(),
      description: description.trim() || null,
      dueDate: fromDateInput(dueDate),
      autoStatus,
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New milestone</DialogTitle>
          <DialogDescription>
            Plot a key date or deliverable on the project timeline.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="milestone-title">Title</Label>
            <Input
              id="milestone-title"
              placeholder="e.g. Beta release"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="milestone-description">Description</Label>
            <Textarea
              id="milestone-description"
              placeholder="What does this milestone represent?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="milestone-due">Due date</Label>
            <Input
              id="milestone-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] p-3">
            <div>
              <Label className="text-sm">Auto status</Label>
              <p className="text-xs text-[var(--text-muted)]">
                Derive status from linked work items.
              </p>
            </div>
            <ToggleSwitch
              checked={autoStatus}
              onCheckedChange={setAutoStatus}
              aria-label="Auto status"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !title.trim() || !dueDate}>
            {submitting ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------------
 * Edit dialog
 * ------------------------------------------------------------------------- */

interface UpdatePayload {
  title?: string;
  description?: string | null;
  dueDate?: string;
  status?: MilestoneStatus;
  autoStatus?: boolean;
}

function EditDialog({
  milestone,
  onOpenChange,
  onSubmit,
  submitting,
}: {
  milestone: Milestone;
  onOpenChange: (open: boolean) => void;
  onSubmit: (patch: UpdatePayload) => void;
  submitting: boolean;
}) {
  const [title, setTitle] = useState(milestone.title);
  const [description, setDescription] = useState(milestone.description ?? "");
  const [dueDate, setDueDate] = useState(toDateInput(milestone.dueDate));
  const [autoStatus, setAutoStatus] = useState(milestone.autoStatus);
  const [status, setStatus] = useState<MilestoneStatus>(milestone.status);

  function submit() {
    if (!title.trim() || !dueDate) return;
    const patch: UpdatePayload = {
      title: title.trim(),
      description: description.trim() || null,
      dueDate: fromDateInput(dueDate),
      autoStatus,
    };
    // Only send a manual status when auto-status is off; otherwise the server
    // derives it and a stored value would just get overwritten on next read.
    if (!autoStatus) patch.status = status;
    onSubmit(patch);
  }

  const meta = STATUS_META[milestone.status];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit milestone</DialogTitle>
          <DialogDescription>
            Update the milestone&apos;s details and status behavior.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-milestone-title">Title</Label>
            <Input
              id="edit-milestone-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-milestone-description">Description</Label>
            <Textarea
              id="edit-milestone-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-milestone-due">Due date</Label>
            <Input
              id="edit-milestone-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] p-3">
            <div>
              <Label className="text-sm">Auto status</Label>
              <p className="text-xs text-[var(--text-muted)]">
                Derive status from linked work items.
              </p>
            </div>
            <ToggleSwitch
              checked={autoStatus}
              onCheckedChange={setAutoStatus}
              aria-label="Auto status"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-milestone-status">Status</Label>
            {autoStatus ? (
              <div className="flex items-center gap-2">
                <Badge variant={meta.badge}>{meta.label}</Badge>
                <span className="text-xs text-[var(--text-muted)]">
                  Derived automatically from linked items.
                </span>
              </div>
            ) : (
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as MilestoneStatus)}
              >
                <SelectTrigger id="edit-milestone-status" className="w-full">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_META[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !title.trim() || !dueDate}>
            {submitting ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------------
 * Link work items dialog
 * ------------------------------------------------------------------------- */

function LinkDialog({
  milestone,
  basePath,
  projectId,
  onOpenChange,
}: {
  milestone: Milestone;
  basePath: string;
  projectId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState("");

  const itemsKey = useOrgQueryKey("work-items", projectId);
  const itemsQ = useQuery({
    queryKey: itemsKey,
    queryFn: () => jsonFetch<WorkItem[]>(`${basePath}/work-items`),
  });
  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);

  const linkMutation = useOrgMutation<MilestoneLink, Error, string>({
    mutationFn: (workItemId) =>
      jsonFetch<MilestoneLink>(`${basePath}/milestones/${milestone.id}/links`, {
        method: "POST",
        body: JSON.stringify({ workItemId }),
      }),
    invalidate: [["milestones", projectId]],
  });

  const unlinkMutation = useOrgMutation<{ id: string }, Error, string>({
    mutationFn: (linkId) =>
      jsonFetch<{ id: string }>(
        `${basePath}/milestones/${milestone.id}/links/${linkId}`,
        { method: "DELETE" },
      ),
    invalidate: [["milestones", projectId]],
  });

  // Map workItemId -> link so linked chips can carry the linkId for removal.
  const linkByItemId = useMemo(() => {
    const map = new Map<string, MilestoneLink>();
    for (const l of milestone.links) map.set(l.workItemId, l);
    return map;
  }, [milestone.links]);

  const itemById = useMemo(() => {
    const map = new Map<string, WorkItem>();
    for (const it of items) map.set(it.id, it);
    return map;
  }, [items]);

  const linkedItems = milestone.links;

  const available = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((it) => !linkByItemId.has(it.id))
      .filter((it) => (q ? it.title.toLowerCase().includes(q) : true))
      .slice(0, 50);
  }, [items, linkByItemId, search]);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link work items</DialogTitle>
          <DialogDescription>
            Connect work items to “{milestone.title}”. Linked items drive
            auto-status.
          </DialogDescription>
        </DialogHeader>

        {/* Linked chips */}
        <div className="space-y-2">
          <Label className="text-xs text-[var(--text-muted)]">
            Linked items ({linkedItems.length})
          </Label>
          {linkedItems.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              No items linked yet.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {linkedItems.map((link) => {
                const item = itemById.get(link.workItemId);
                return (
                  <span
                    key={link.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--primary-tint)] px-2.5 py-1 text-xs text-[var(--text)]"
                  >
                    <span className="max-w-[180px] truncate">
                      {item ? item.title : "Unknown item"}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove link"
                      className="text-[var(--text-muted)] hover:text-[var(--text)]"
                      onClick={() => unlinkMutation.mutate(link.id)}
                      disabled={unlinkMutation.isPending}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* Picker */}
        <div className="space-y-2">
          <Label htmlFor="milestone-link-search" className="text-xs text-[var(--text-muted)]">
            Add an item
          </Label>
          <Input
            id="milestone-link-search"
            placeholder="Search work items…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-56 overflow-y-auto rounded-[var(--radius)] border border-[var(--border)]">
            {itemsQ.isLoading ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : itemsQ.error ? (
              <p className="p-3 text-sm text-[var(--status-critical-text)]">
                Failed to load work items.
              </p>
            ) : available.length === 0 ? (
              <p className="p-3 text-sm text-[var(--text-muted)]">
                {search.trim() ? "No matching items." : "No items to link."}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {available.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm",
                        "hover:bg-[var(--primary-tint)] disabled:opacity-50",
                      )}
                      onClick={() => linkMutation.mutate(it.id)}
                      disabled={linkMutation.isPending}
                    >
                      <span className="min-w-0 flex-1 truncate text-[var(--text)]">
                        {it.title}
                      </span>
                      <Plus className="size-4 shrink-0 text-[var(--text-muted)]" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------------
 * Loading skeleton
 * ------------------------------------------------------------------------- */

function MilestonesSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 md:p-8">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>
      <Skeleton className="h-24 w-full" />
      <div className="space-y-3 pl-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    </div>
  );
}
