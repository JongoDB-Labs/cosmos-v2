"use client";

import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { DatePicker } from "@/components/ui/date-picker";
import type { WorkItem, BoardColumn, OrgMember, Interval } from "@/types/models";

const PRIORITIES = [
  { value: "CRITICAL", label: "Critical" },
  { value: "HIGH", label: "High" },
  { value: "MEDIUM", label: "Medium" },
  { value: "LOW", label: "Low" },
] as const;

/**
 * Pick the default type to preselect: the project's "task" type if present
 * (built-in keys end with `.task`), else the first type. Returns "" while the
 * list is still loading/empty.
 */
function defaultTypeId(types: { id: string; key: string }[]): string {
  if (types.length === 0) return "";
  const task = types.find((t) => t.key === "task" || t.key.endsWith(".task"));
  return (task ?? types[0]).id;
}

/** Every optional/preset detail the create dialog can submit. */
export interface CreateIssueFields {
  title: string;
  workItemTypeId: string;
  columnKey: string;
  priority: string;
  assigneeIds: string[];
  intervalId: string | null;
  startDate: string; // yyyy-mm-dd (empty = unset)
  dueDate: string; // yyyy-mm-dd (empty = unset)
  /** Preset tags applied at creation — e.g. the RAID category (COSMOS-80). */
  tags: string[];
}

/**
 * Assemble the create-work-item POST body from the dialog's field values.
 * Extracted (and exported) so the "which fields get submitted" logic — notably
 * the RAID category preset that keeps a new RAID-log entry OUT of
 * "Unclassified" (COSMOS-80) — is unit-testable without driving the base-ui
 * dialog. Falls back to the bare "TASK" type when the async types fetch hasn't
 * resolved, so creation never silently no-ops; omits every empty optional.
 */
export function buildCreateBody(f: CreateIssueFields): Record<string, unknown> {
  return {
    title: f.title.trim(),
    ...(f.workItemTypeId ? { workItemTypeId: f.workItemTypeId } : { type: "TASK" }),
    columnKey: f.columnKey,
    priority: f.priority,
    ...(f.assigneeIds.length > 0 ? { assigneeIds: f.assigneeIds } : {}),
    ...(f.intervalId ? { intervalId: f.intervalId } : {}),
    ...(f.startDate
      ? { startDate: new Date(f.startDate + "T00:00:00Z").toISOString() }
      : {}),
    ...(f.dueDate
      ? { dueDate: new Date(f.dueDate + "T00:00:00Z").toISOString() }
      : {}),
    ...(f.tags.length > 0 ? { tags: f.tags } : {}),
  };
}

/**
 * A self-contained "+ New issue" affordance for the board views that lack
 * per-column quick-create (table, backlog, timeline, calendar, RAID) and the
 * org-wide Issues view. Opens a small dialog (title + type + status) and POSTs
 * to the work-items create endpoint; the status options are the board's own
 * columns, fetched on open so the caller only has to pass boardId. The caller's
 * onCreated refreshes its view (e.g. invalidate the work-items query).
 */
export function CreateIssueButton({
  orgId,
  projectId,
  boardId,
  onCreated,
  label = "New issue",
  variant = "outline",
  categoryPreset,
}: {
  orgId: string;
  projectId: string;
  boardId: string;
  onCreated: (item: WorkItem) => void;
  label?: string;
  variant?: "outline" | "default" | "ghost";
  /**
   * Opt-in "category" selector (RAID log, COSMOS-80): when set, the dialog shows
   * a Category <Select> seeded to `defaultValue`, and the chosen value is
   * submitted as the new item's tag — so a RAID-log entry defaults to a real
   * category instead of automatically landing "Unclassified". Views that omit
   * this prop are unaffected (no selector, no tag).
   */
  categoryPreset?: {
    options: { value: string; label: string }[];
    defaultValue: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [title, setTitle] = useState("");
  const [workItemTypeId, setWorkItemTypeId] = useState("");
  const [columnKey, setColumnKey] = useState("");
  const [pending, setPending] = useState(false);
  const [loadingCols, setLoadingCols] = useState(false);
  // FR fc20e6da: every core detail settable at creation time, not just
  // title/type/status. All optional — the fast path stays two clicks.
  const [priority, setPriority] = useState<string>("MEDIUM");
  // Multi-assign (FR 1d38496a): full set; the first pick becomes the primary.
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [intervalId, setIntervalId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  // RAID category preset (COSMOS-80): seeded to the caller's default so a new
  // entry never lands "Unclassified"; the user can still change it.
  const [presetTag, setPresetTag] = useState(categoryPreset?.defaultValue ?? "");

  const membersKey = useOrgQueryKey("members");
  const intervalsKey = useOrgQueryKey("intervals", projectId);
  const { data: members = [] } = useQuery({
    queryKey: membersKey,
    queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
    enabled: open,
    staleTime: 60_000,
  });
  const { data: intervals = [] } = useQuery({
    queryKey: intervalsKey,
    queryFn: () =>
      jsonFetch<Interval[]>(`/api/v1/orgs/${orgId}/projects/${projectId}/intervals`),
    enabled: open,
    staleTime: 60_000,
  });
  // The org's ACTUAL types (built-ins + custom). We submit the selected type's
  // id so a custom type (bare key like "feature") resolves — sending the bare
  // `type` string would make the server build a sector-prefixed key that misses.
  const { types: workItemTypes } = useWorkItemTypes(orgId);

  // Default / repair the Type selection once the types load while the dialog is
  // open (openDialog seeds it eagerly, but the list may still be in flight).
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorkItemTypeId((prev) =>
      prev && workItemTypes.some((t) => t.id === prev)
        ? prev
        : defaultTypeId(workItemTypes),
    );
  }, [open, workItemTypes]);

  async function openDialog() {
    setOpen(true);
    setWorkItemTypeId((prev) =>
      prev && workItemTypes.some((t) => t.id === prev)
        ? prev
        : defaultTypeId(workItemTypes),
    );
    setLoadingCols(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/boards/${boardId}`,
      );
      if (res.ok) {
        const board = await res.json();
        const cols: BoardColumn[] = (board.columns ?? []).sort(
          (a: BoardColumn, b: BoardColumn) => a.sortOrder - b.sortOrder,
        );
        setColumns(cols);
        setColumnKey((prev) => prev || cols[0]?.key || "");
      }
    } catch {
      /* leave columns empty — the create button stays disabled until one loads */
    } finally {
      setLoadingCols(false);
    }
  }

  async function handleCreate() {
    if (!title.trim() || !columnKey) return;
    setPending(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/work-items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildCreateBody({
              title,
              workItemTypeId,
              columnKey,
              priority,
              assigneeIds,
              intervalId,
              startDate,
              dueDate,
              // Only tag when a preset is active (RAID log); other views send none.
              tags: categoryPreset && presetTag ? [presetTag] : [],
            }),
          ),
        },
      );
      if (!res.ok) throw new Error(`Failed to create issue (HTTP ${res.status})`);
      const item: WorkItem = await res.json();
      toast.success(`Created #${item.ticketNumber}`);
      onCreated(item);
      setTitle("");
      setWorkItemTypeId(defaultTypeId(workItemTypes));
      setPriority("MEDIUM");
      setAssigneeIds([]);
      setIntervalId(null);
      setStartDate("");
      setDueDate("");
      setPresetTag(categoryPreset?.defaultValue ?? "");
      setOpen(false);
    } catch (err) {
      notifyError(err, "Couldn't create the issue.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button size="sm" variant={variant} className="gap-1.5" onClick={openDialog}>
        <Plus className="h-3.5 w-3.5" />
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !pending) setOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  title.trim() &&
                  columnKey &&
                  workItemTypeId &&
                  !pending
                ) {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder="Issue title"
              disabled={pending}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select
                items={Object.fromEntries(
                  workItemTypes.map((t) => [t.id, t.name]),
                )}
                value={workItemTypeId}
                onValueChange={(v) => v && setWorkItemTypeId(v as string)}
                disabled={workItemTypes.length === 0}
              >
                <SelectTrigger size="sm" aria-label="Issue type" className="w-32 text-xs">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  {workItemTypes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                items={Object.fromEntries(columns.map((c) => [c.key, c.name]))}
                value={columnKey}
                onValueChange={(v) => v && setColumnKey(v as string)}
                disabled={loadingCols || columns.length === 0}
              >
                <SelectTrigger size="sm" aria-label="Status" className="w-40 text-xs">
                  <SelectValue placeholder={loadingCols ? "Loading…" : "Status"} />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                items={Object.fromEntries(PRIORITIES.map((p) => [p.value, p.label]))}
                value={priority}
                onValueChange={(v) => v && setPriority(v as string)}
              >
                <SelectTrigger size="sm" aria-label="Priority" className="w-28 text-xs">
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* RAID category (COSMOS-80): only when the caller opts in, so a
                  new RAID-log entry defaults to a real category, not
                  "Unclassified". */}
              {categoryPreset && (
                <Select
                  items={Object.fromEntries(
                    categoryPreset.options.map((o) => [o.value, o.label]),
                  )}
                  value={presetTag}
                  onValueChange={(v) => v && setPresetTag(v as string)}
                >
                  <SelectTrigger size="sm" aria-label="Category" className="w-32 text-xs">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryPreset.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Optional details (FR fc20e6da) — assignees/interval/dates at creation.
                Assignees is a MULTI-select (FR 1d38496a): first pick = primary. */}
            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Assignees"
                  className="inline-flex h-8 w-44 items-center justify-between rounded-lg border border-input px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 disabled:opacity-50"
                  disabled={members.length === 0}
                >
                  <span className="truncate">
                    {assigneeIds.length === 0
                      ? "Assignees"
                      : assigneeIds
                          .map(
                            (id) =>
                              members.find((m) => m.userId === id)?.user
                                ?.displayName ?? "Unknown",
                          )
                          .slice(0, 2)
                          .join(", ") +
                        (assigneeIds.length > 2 ? ` +${assigneeIds.length - 2}` : "")}
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 min-w-52 overflow-y-auto">
                  {members.map((m) => (
                    <DropdownMenuCheckboxItem
                      key={m.userId}
                      checked={assigneeIds.includes(m.userId)}
                      onCheckedChange={(c) =>
                        setAssigneeIds((prev) =>
                          c
                            ? [...prev, m.userId]
                            : prev.filter((id) => id !== m.userId),
                        )
                      }
                    >
                      {m.user?.displayName ?? m.user?.email ?? "Unknown"}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {intervals.length > 0 && (
                <Select
                  items={{
                    __none__: "No interval",
                    ...Object.fromEntries(intervals.map((c) => [c.id, c.name])),
                  }}
                  value={intervalId ?? "__none__"}
                  onValueChange={(v) =>
                    setIntervalId(v === "__none__" ? null : (v as string))
                  }
                >
                  <SelectTrigger size="sm" aria-label="Interval" className="w-36 text-xs">
                    <SelectValue placeholder="Interval" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No interval</SelectItem>
                    {intervals.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <DatePicker
                value={startDate}
                onValueChange={setStartDate}
                aria-label="Start date"
                placeholder="Start date"
                className="h-8 w-36 text-xs"
              />
              <DatePicker
                value={dueDate}
                onValueChange={setDueDate}
                aria-label="Due date"
                placeholder="Due date"
                className="h-8 w-36 text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!title.trim() || !columnKey || pending}
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Create issue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
