"use client";

import { useState, useMemo, useCallback, type ReactNode } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";
import {
  createColumnHelper,
  type ColumnDef,
  type RowSelectionState,
  type GroupingState,
} from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { CreateIssueButton } from "@/components/boards/shared/create-issue-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DatePicker } from "@/components/ui/date-picker";
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
import {
  usePermissions,
  Permission,
} from "@/components/providers/permissions-provider";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Check,
  X,
  Trash2,
  Rows3,
  Rows4,
  Pencil,
  Flag,
  CircleDot,
  UserCog,
  CalendarClock,
  Copy,
  ListFilter,
  ChevronDown,
} from "lucide-react";
import type { ActionMenuGroup } from "@/components/ui/action-menu";
import type { WorkItem, Board, BoardColumn, OrgMember, Interval } from "@/types/models";

interface TableViewProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

const priorityColors: Record<string, string> = {
  CRITICAL: "bg-red-500/20 text-red-400",
  HIGH: "bg-orange-500/20 text-orange-400",
  MEDIUM: "bg-blue-500/20 text-blue-400",
  LOW: "bg-muted text-muted-foreground",
};

const typeColors: Record<string, string> = {
  EPIC: "bg-purple-500/20 text-purple-400",
  STORY: "bg-blue-500/20 text-blue-400",
  TASK: "bg-cyan-500/20 text-cyan-400",
  BUG: "bg-red-500/20 text-red-400",
  SUBTASK: "bg-muted text-muted-foreground",
};

const GROUPING_OPTIONS = [
  { value: "", label: "No grouping" },
  { value: "columnKey", label: "Status" },
  { value: "type", label: "Type" },
  { value: "priority", label: "Priority" },
  { value: "assigneeId", label: "Assignee" },
] as const;

const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

type Density = "comfortable" | "compact";

type EditingCell = {
  rowId: string;
  columnId: string;
  value: string;
} | null;

export function TableView({ orgId, projectId, projectKey, boardId }: TableViewProps) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [grouping, setGrouping] = useState<GroupingState>([]);
  const [editingCell, setEditingCell] = useState<EditingCell>(null);
  const [density, setDensity] = useState<Density>("comfortable");
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [tagDraft, setTagDraft] = useState("");

  const canBulkEdit = can(Permission.ITEM_BULK_EDIT);
  const canBulkDelete = can(Permission.ITEM_DELETE);
  const canCreate = can(Permission.ITEM_CREATE);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const boardKey = useOrgQueryKey("board", boardId);
  const itemsKey = useOrgQueryKey("work-items", projectId);
  const membersKey = useOrgQueryKey("members");
  const intervalsKey = useOrgQueryKey("intervals", projectId);

  const [boardQ, itemsQ, membersQ, intervalsQ] = useQueries({
    queries: [
      {
        queryKey: boardKey,
        queryFn: () => jsonFetch<Board>(`${basePath}/boards/${boardId}`),
      },
      {
        queryKey: itemsKey,
        queryFn: () => jsonFetch<WorkItem[]>(`${basePath}/work-items`),
      },
      {
        queryKey: membersKey,
        queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
      },
      {
        queryKey: intervalsKey,
        queryFn: () => jsonFetch<Interval[]>(`${basePath}/intervals`),
      },
    ],
  });

  const board: Board | null = boardQ.data ?? null;
  const columns: BoardColumn[] = useMemo(
    () => (board?.columns ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [board],
  );
  const allItems: WorkItem[] = itemsQ.data ?? [];
  const members: OrgMember[] = membersQ.data ?? [];
  const intervals: Interval[] = intervalsQ.data ?? [];

  // Type filter (FR debd4e39): a TABLE board can be scoped to specific work-item
  // types — e.g. a "Bug Tracker" that shows only bugs instead of every ticket.
  // The choice lives in board.config.typeKeys (persisted), so it's the single
  // source of truth; an empty/absent list means "show all types".
  const typeKeys: string[] = useMemo(() => {
    const raw = (board?.config as { typeKeys?: unknown } | undefined)?.typeKeys;
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
  }, [board]);

  // Distinct types present in the board's items, for the filter menu options.
  const typeOptions = useMemo(() => {
    const seen = new Map<string, { key: string; name: string }>();
    for (const it of allItems) {
      const t = it.workItemType;
      if (t?.key && !seen.has(t.key)) seen.set(t.key, { key: t.key, name: t.name });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [allItems]);

  const items: WorkItem[] = useMemo(
    () =>
      typeKeys.length === 0
        ? allItems
        : allItems.filter((i) => i.workItemType?.key && typeKeys.includes(i.workItemType.key)),
    [allItems, typeKeys],
  );

  // Persist a change to the board's type filter (optimistic: patch the board
  // cache so the table re-filters immediately, then PUT the merged config).
  const setTypeKeys = useCallback(
    (next: string[]) => {
      qc.setQueryData<Board>(boardKey, (prev) =>
        prev ? { ...prev, config: { ...prev.config, typeKeys: next } } : prev,
      );
      void jsonFetch(`${basePath}/boards/${boardId}`, {
        method: "PUT",
        body: JSON.stringify({ config: { ...(board?.config ?? {}), typeKeys: next } }),
      }).catch((err) => {
        notifyError(err, "Couldn't save the type filter.");
        void qc.invalidateQueries({ queryKey: boardKey });
      });
    },
    [qc, boardKey, basePath, boardId, board],
  );

  const loading =
    boardQ.isLoading ||
    itemsQ.isLoading ||
    membersQ.isLoading ||
    intervalsQ.isLoading;
  const fatalError = boardQ.error || itemsQ.error;
  const error = fatalError
    ? fatalError instanceof Error
      ? fatalError.message
      : "Unknown error"
    : null;

  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.userId, m.user?.displayName ?? m.user?.email ?? "Unknown");
    }
    return map;
  }, [members]);

  const memberById = useMemo(() => {
    const map = new Map<string, OrgMember>();
    for (const m of members) map.set(m.userId, m);
    return map;
  }, [members]);

  const columnMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of columns) {
      map.set(c.key, c.name);
    }
    return map;
  }, [columns]);

  const intervalMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of intervals) {
      map.set(s.id, s.name);
    }
    return map;
  }, [intervals]);

  const saveEdit = useCallback(
    async (rowId: string, field: string, value: string) => {
      let payload: Record<string, unknown> = {};
      if (field === "title") payload = { title: value };
      else if (field === "priority") payload = { priority: value };
      else if (field === "assigneeId") payload = { assigneeId: value || null };
      else if (field === "storyPoints") payload = { storyPoints: value ? Number(value) : null };
      else if (field === "columnKey") payload = { columnKey: value };
      else if (field === "dueDate")
        payload = { dueDate: value ? new Date(value).toISOString() : null };
      else return;

      // Optimistic cache update
      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        (prev ?? []).map((i) => (i.id === rowId ? { ...i, ...payload } : i)),
      );

      try {
        await jsonFetch(`${basePath}/work-items/${rowId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.error("Failed to update work item:", err);
        notifyError(err, "Couldn't save your change.");
        // Rollback by refetching
        qc.invalidateQueries({ queryKey: itemsKey });
      }
    },
    [qc, itemsKey, basePath],
  );

  const selectedIds = useMemo(
    () => Object.keys(rowSelection).filter((k) => rowSelection[k]),
    [rowSelection],
  );

  // Bulk-edit any subset of fields on the currently selected rows. Mirrors the
  // single-row optimistic pattern in saveEdit: patch the work-items cache,
  // clear the selection, and on failure surface a toast + refetch to rollback.
  // The server contract wraps the changed fields in an `update` object
  // ({ ids, update: { columnKey | assigneeId | priority | intervalId | tags } }).
  const bulkUpdate = useCallback(
    async (update: Partial<WorkItem>) => {
      if (selectedIds.length === 0) return;
      const ids = new Set(selectedIds);

      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        (prev ?? []).map((i) => (ids.has(i.id) ? { ...i, ...update } : i)),
      );

      try {
        await jsonFetch(`${basePath}/work-items/bulk`, {
          method: "PUT",
          body: JSON.stringify({ ids: selectedIds, update }),
        });
        // Success: dismiss the floating bulk toolbar (matches bulkDelete). On
        // failure we keep the selection so the user can retry.
        setRowSelection({});
      } catch (err) {
        notifyError(err, "Couldn't apply the bulk change.");
        qc.invalidateQueries({ queryKey: itemsKey });
      }
    },
    [selectedIds, qc, itemsKey, basePath],
  );

  // Adding a tag must preserve each item's *own* existing tags — but the bulk
  // endpoint writes one tags array for every id it's given. So bucket the
  // selection by current tag-set signature and fire one bulk PUT per bucket,
  // each with that bucket's existing tags ∪ {tag}. Items that already carry the
  // tag are skipped. Optimistic patch mirrors bulkUpdate.
  const addTagToSelected = useCallback(
    async (tag: string) => {
      if (selectedIds.length === 0) return;
      const sel = new Set(selectedIds);
      const current = qc.getQueryData<WorkItem[]>(itemsKey) ?? [];

      const buckets = new Map<string, { ids: string[]; tags: string[] }>();
      for (const it of current) {
        if (!sel.has(it.id) || it.tags.includes(tag)) continue;
        const sig = JSON.stringify([...it.tags].sort());
        const bucket = buckets.get(sig);
        if (bucket) bucket.ids.push(it.id);
        else buckets.set(sig, { ids: [it.id], tags: [...it.tags, tag] });
      }
      if (buckets.size === 0) return;

      const affected = new Set<string>();
      for (const b of buckets.values()) for (const id of b.ids) affected.add(id);
      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        (prev ?? []).map((i) =>
          affected.has(i.id) ? { ...i, tags: [...i.tags, tag] } : i,
        ),
      );

      try {
        await Promise.all(
          Array.from(buckets.values()).map((b) =>
            jsonFetch(`${basePath}/work-items/bulk`, {
              method: "PUT",
              body: JSON.stringify({ ids: b.ids, update: { tags: b.tags } }),
            }),
          ),
        );
        setRowSelection({});
      } catch (err) {
        notifyError(err, "Couldn't add the tag.");
        qc.invalidateQueries({ queryKey: itemsKey });
      }
    },
    [selectedIds, qc, itemsKey, basePath],
  );

  // Delete is destructive, so route it through useOrgMutation (toast-on-error
  // built in) and confirm via a Dialog. Optimistically drop the rows, clear the
  // selection, then invalidate so any server-side cascade is reconciled.
  const bulkDeleteMutation = useOrgMutation<unknown, Error, string[]>({
    mutationFn: (ids) =>
      jsonFetch(`${basePath}/work-items/bulk`, {
        method: "DELETE",
        body: JSON.stringify({ ids }),
      }),
    invalidate: [["work-items", projectId]],
    onMutate: (ids) => {
      const set = new Set(ids);
      const previous = qc.getQueryData<WorkItem[]>(itemsKey);
      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        (prev ?? []).filter((i) => !set.has(i.id)),
      );
      return { previous };
    },
    onError: (err, _ids, context) => {
      const ctx = context as { previous?: WorkItem[] } | undefined;
      if (ctx?.previous) qc.setQueryData(itemsKey, ctx.previous);
      notifyError(err, "Couldn't delete the selected items.");
    },
    onSuccess: () => {
      setRowSelection({});
      setConfirmBulkDelete(false);
    },
  });

  // Surface the per-row operations already reachable by clicking a cell
  // (inline-edit openers via setEditingCell) plus a single-row delete (reusing
  // bulkDeleteMutation with a one-id array) and a copy-key helper, as a
  // right-click / ⋯ menu. Delete is gated by the same ITEM_DELETE check used by
  // the bulk toolbar.
  const rowActions = useCallback(
    (item: WorkItem): ActionMenuGroup[] => {
      const groups: ActionMenuGroup[] = [
        {
          items: [
            {
              label: "Edit title",
              icon: Pencil,
              onClick: () =>
                setEditingCell({
                  rowId: item.id,
                  columnId: "title",
                  value: item.title,
                }),
            },
            {
              label: "Change status",
              icon: CircleDot,
              onClick: () =>
                setEditingCell({
                  rowId: item.id,
                  columnId: "columnKey",
                  value: item.columnKey,
                }),
            },
            {
              label: "Set priority",
              icon: Flag,
              onClick: () =>
                setEditingCell({
                  rowId: item.id,
                  columnId: "priority",
                  value: item.priority,
                }),
            },
            {
              label: "Assign",
              icon: UserCog,
              onClick: () =>
                setEditingCell({
                  rowId: item.id,
                  columnId: "assigneeId",
                  value: item.assigneeId ?? "",
                }),
            },
            {
              label: "Set due date",
              icon: CalendarClock,
              onClick: () =>
                setEditingCell({
                  rowId: item.id,
                  columnId: "dueDate",
                  value: item.dueDate ?? "",
                }),
            },
            {
              label: "Copy issue key",
              icon: Copy,
              onClick: () => {
                void navigator.clipboard.writeText(
                  `${projectKey}-${item.ticketNumber}`,
                );
              },
            },
          ],
        },
      ];

      if (canCreate) {
        groups.push({
          items: [
            {
              label: "Duplicate",
              icon: Copy,
              onClick: async () => {
                try {
                  await jsonFetch(`${basePath}/work-items/${item.id}/duplicate`, {
                    method: "POST",
                  });
                  toast.success("Issue duplicated");
                  void qc.invalidateQueries({ queryKey: itemsKey });
                } catch (err) {
                  notifyError(err, "Couldn't duplicate the issue.");
                }
              },
            },
          ],
        });
      }

      if (canBulkDelete) {
        groups.push({
          items: [
            {
              label: "Delete",
              icon: Trash2,
              variant: "destructive",
              onClick: () => bulkDeleteMutation.mutate([item.id]),
            },
          ],
        });
      }

      return groups;
    },
    [canBulkDelete, canCreate, bulkDeleteMutation, projectKey, basePath, qc, itemsKey],
  );

  const columnHelper = createColumnHelper<WorkItem>();

  const tableColumns = useMemo<ColumnDef<WorkItem>[]>(
    () => [
      columnHelper.accessor("workItemTypeId", {
        header: "Type",
        cell: (info) => {
          const item = info.row.original;
          return (
            <Badge className="text-[10px] bg-muted text-muted-foreground">
              {item.workItemType?.name ?? info.getValue()}
            </Badge>
          );
        },
        size: 100,
      }),
      columnHelper.accessor("title", {
        header: "Title",
        cell: (info) => {
          const isEditing =
            editingCell?.rowId === info.row.original.id &&
            editingCell?.columnId === "title";
          if (isEditing) {
            return (
              <EditableInput
                value={editingCell.value}
                onChange={(v) =>
                  setEditingCell({ ...editingCell, value: v })
                }
                onSave={() => {
                  saveEdit(info.row.original.id, "title", editingCell.value);
                  setEditingCell(null);
                }}
                onCancel={() => setEditingCell(null)}
              />
            );
          }
          return (
            <button
              type="button"
              className="text-left w-full truncate hover:text-primary transition-colors"
              onClick={() =>
                setEditingCell({
                  rowId: info.row.original.id,
                  columnId: "title",
                  value: info.getValue(),
                })
              }
            >
              <span className="text-muted-foreground mr-1.5 text-xs">
                {projectKey}-{info.row.original.ticketNumber}
              </span>
              {info.getValue()}
            </button>
          );
        },
        size: 350,
      }),
      columnHelper.accessor("priority", {
        header: "Priority",
        cell: (info) => {
          const isEditing =
            editingCell?.rowId === info.row.original.id &&
            editingCell?.columnId === "priority";
          if (isEditing) {
            return (
              <select
                value={editingCell.value}
                onChange={(e) => {
                  saveEdit(info.row.original.id, "priority", e.target.value);
                  setEditingCell(null);
                }}
                onBlur={() => setEditingCell(null)}
                autoFocus
                className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none"
              >
                {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            );
          }
          return (
            <button
              type="button"
              onClick={() =>
                setEditingCell({
                  rowId: info.row.original.id,
                  columnId: "priority",
                  value: info.getValue(),
                })
              }
            >
              <Badge className={cn("text-[10px]", priorityColors[info.getValue()])}>
                {info.getValue()}
              </Badge>
            </button>
          );
        },
        size: 110,
      }),
      columnHelper.accessor("columnKey", {
        header: "Status",
        cell: (info) => {
          const isEditing =
            editingCell?.rowId === info.row.original.id &&
            editingCell?.columnId === "columnKey";
          if (isEditing) {
            return (
              <select
                value={editingCell.value}
                onChange={(e) => {
                  saveEdit(info.row.original.id, "columnKey", e.target.value);
                  setEditingCell(null);
                }}
                onBlur={() => setEditingCell(null)}
                autoFocus
                className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none"
              >
                {columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                  </option>
                ))}
              </select>
            );
          }
          return (
            <button
              type="button"
              className="text-sm text-left hover:text-primary transition-colors"
              onClick={() =>
                setEditingCell({
                  rowId: info.row.original.id,
                  columnId: "columnKey",
                  value: info.getValue(),
                })
              }
            >
              {columnMap.get(info.getValue()) ?? info.getValue()}
            </button>
          );
        },
        size: 130,
      }),
      columnHelper.accessor("assigneeId", {
        header: "Assignee",
        cell: (info) => {
          const isEditing =
            editingCell?.rowId === info.row.original.id &&
            editingCell?.columnId === "assigneeId";
          if (isEditing) {
            return (
              <select
                value={editingCell.value}
                onChange={(e) => {
                  saveEdit(info.row.original.id, "assigneeId", e.target.value);
                  setEditingCell(null);
                }}
                onBlur={() => setEditingCell(null)}
                autoFocus
                className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none"
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.user?.displayName ?? m.user?.email ?? "Unknown"}
                  </option>
                ))}
              </select>
            );
          }
          const val = info.getValue();
          const member = val ? memberById.get(val) : undefined;
          const name = val ? memberMap.get(val) ?? "Unknown" : null;
          return (
            <button
              type="button"
              className="flex items-center gap-1.5 text-sm text-left hover:text-primary transition-colors"
              onClick={() =>
                setEditingCell({
                  rowId: info.row.original.id,
                  columnId: "assigneeId",
                  value: val ?? "",
                })
              }
            >
              {name ? (
                <>
                  <Avatar size="sm">
                    {member?.user?.avatarUrl && (
                      <AvatarImage src={member.user.avatarUrl} />
                    )}
                    <AvatarFallback>
                      {name.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate">{name}</span>
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </button>
          );
        },
        size: 160,
      }),
      columnHelper.accessor("intervalId", {
        header: "Interval",
        cell: (info) => {
          const val = info.getValue();
          return (
            <span className="text-sm">
              {val ? intervalMap.get(val) ?? "—" : "—"}
            </span>
          );
        },
        size: 120,
      }),
      columnHelper.accessor("storyPoints", {
        header: "Points",
        cell: (info) => {
          const isEditing =
            editingCell?.rowId === info.row.original.id &&
            editingCell?.columnId === "storyPoints";
          if (isEditing) {
            return (
              <EditableInput
                value={editingCell.value}
                onChange={(v) =>
                  setEditingCell({ ...editingCell, value: v })
                }
                onSave={() => {
                  saveEdit(info.row.original.id, "storyPoints", editingCell.value);
                  setEditingCell(null);
                }}
                onCancel={() => setEditingCell(null)}
                type="number"
              />
            );
          }
          const val = info.getValue();
          return (
            <button
              type="button"
              className="text-sm text-center w-full hover:text-primary transition-colors"
              onClick={() =>
                setEditingCell({
                  rowId: info.row.original.id,
                  columnId: "storyPoints",
                  value: val != null ? String(val) : "",
                })
              }
            >
              {val ?? "—"}
            </button>
          );
        },
        size: 80,
      }),
      columnHelper.accessor("dueDate", {
        header: "Due Date",
        cell: (info) => {
          const isEditing =
            editingCell?.rowId === info.row.original.id &&
            editingCell?.columnId === "dueDate";
          if (isEditing) {
            return (
              <DatePicker
                value={editingCell.value || undefined}
                aria-label="Due date"
                className="h-7 w-40"
                onValueChange={(v) => {
                  saveEdit(info.row.original.id, "dueDate", v);
                  setEditingCell(null);
                }}
              />
            );
          }
          const val = info.getValue();
          const d = val ? new Date(val) : null;
          const isOverdue =
            d != null && d < new Date() && !info.row.original.completedAt;
          return (
            <button
              type="button"
              className={cn(
                "text-sm text-left hover:text-primary transition-colors",
                isOverdue && "text-red-400",
              )}
              onClick={() =>
                setEditingCell({
                  rowId: info.row.original.id,
                  columnId: "dueDate",
                  value: val ?? "",
                })
              }
            >
              {d ? (
                d.toLocaleDateString()
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </button>
          );
        },
        size: 150,
      }),
      columnHelper.accessor("tags", {
        header: "Tags",
        cell: (info) => {
          const tags = info.getValue();
          if (!tags || tags.length === 0) return null;
          return (
            <div className="flex gap-1 flex-wrap">
              {tags.slice(0, 3).map((t) => (
                <Badge key={t} variant="neutral" className="text-[10px]">
                  {t}
                </Badge>
              ))}
              {tags.length > 3 && (
                <span className="text-xs text-muted-foreground">
                  +{tags.length - 3}
                </span>
              )}
            </div>
          );
        },
        size: 160,
        enableSorting: false,
      }),
    ] as ColumnDef<WorkItem>[],
    [columnHelper, editingCell, memberMap, memberById, columnMap, intervalMap, columns, members, projectKey, saveEdit]
  );

  const selectedCount = selectedIds.length;

  if (loading) {
    return <TableViewSkeleton />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-sm text-destructive mb-2">Failed to load board</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b bg-background/50">
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground mr-1">Group by:</span>
          <select
            value={grouping[0] ?? ""}
            onChange={(e) =>
              setGrouping(e.target.value ? [e.target.value] : [])
            }
            className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none"
          >
            {GROUPING_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Type filter (FR debd4e39): scope the board to specific item types. */}
        {typeOptions.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors",
                typeKeys.length > 0
                  ? "border-primary/50 text-foreground"
                  : "border-input text-muted-foreground hover:bg-muted",
              )}
            >
              <ListFilter className="h-3.5 w-3.5" />
              {typeKeys.length === 0
                ? "All types"
                : typeKeys.length === 1
                  ? (typeOptions.find((t) => t.key === typeKeys[0])?.name ?? "1 type")
                  : `${typeKeys.length} types`}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44">
              {typeOptions.map((t) => (
                <DropdownMenuCheckboxItem
                  key={t.key}
                  checked={typeKeys.includes(t.key)}
                  onCheckedChange={(c) =>
                    setTypeKeys(
                      c ? [...typeKeys, t.key] : typeKeys.filter((k) => k !== t.key),
                    )
                  }
                >
                  {t.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <span className="text-xs text-muted-foreground">
          {items.length}
          {typeKeys.length > 0 ? ` of ${allItems.length}` : ""} items
        </span>

        {selectedCount > 0 && (
          <span className="text-xs text-primary font-medium">
            {selectedCount} selected
          </span>
        )}

        {/* New issue + density toggle — pushed to the right edge of the toolbar */}
        <div className="ml-auto flex items-center gap-2">
          <CreateIssueButton
            orgId={orgId}
            projectId={projectId}
            boardId={boardId}
            onCreated={() => qc.invalidateQueries({ queryKey: itemsKey })}
          />
          <DensityButton
            label="Comfortable rows"
            active={density === "comfortable"}
            onClick={() => setDensity("comfortable")}
            icon={<Rows3 className="h-3.5 w-3.5" />}
          />
          <DensityButton
            label="Compact rows"
            active={density === "compact"}
            onClick={() => setDensity("compact")}
            icon={<Rows4 className="h-3.5 w-3.5" />}
          />
        </div>
      </div>

      {/* Table */}
      <div
        className={cn(
          "flex-1 overflow-auto",
          // Compact tightens the data-table's fixed cell padding (it hardcodes
          // md:py-3) so more rows fit on screen, PM-tool style.
          density === "compact" && "[&_td]:md:py-1.5 [&_th]:md:py-2",
        )}
      >
        <DataTable<WorkItem>
          columns={tableColumns}
          data={items}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          grouping={grouping}
          onGroupingChange={setGrouping}
          rowActions={rowActions}
          pagination={{ pageSize: 50 }}
          stickyHeader
        />
      </div>

      {/* Bulk-action toolbar — floats over the table while rows are selected */}
      {selectedCount > 0 && (canBulkEdit || canBulkDelete) && (
        <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center px-4">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border bg-popover/95 px-3 py-2 shadow-lg ring-1 ring-foreground/10 supports-backdrop-filter:backdrop-blur">
            <span className="text-xs font-medium text-foreground">
              {selectedCount} selected
            </span>
            <button
              type="button"
              onClick={() => setRowSelection({})}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>

            {canBulkEdit && (
              <>
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />

                {/* Set status */}
                <BulkSelect
                  placeholder="Set status"
                  ariaLabel="Set status for selected items"
                  onValueChange={(v) => bulkUpdate({ columnKey: v })}
                  options={columns.map((c) => ({ value: c.key, label: c.name }))}
                />

                {/* Assign to */}
                <BulkSelect
                  placeholder="Assign to"
                  ariaLabel="Assign selected items"
                  onValueChange={(v) =>
                    bulkUpdate({ assigneeId: v === "__none" ? null : v })
                  }
                  options={[
                    { value: "__none", label: "Unassigned" },
                    ...members.map((m) => ({
                      value: m.userId,
                      label: m.user?.displayName ?? m.user?.email ?? "Unknown",
                    })),
                  ]}
                />

                {/* Set priority */}
                <BulkSelect
                  placeholder="Priority"
                  ariaLabel="Set priority for selected items"
                  onValueChange={(v) =>
                    bulkUpdate({ priority: v as WorkItem["priority"] })
                  }
                  options={PRIORITIES.map((p) => ({ value: p, label: p }))}
                />

                {/* Add to interval */}
                <BulkSelect
                  placeholder="Interval"
                  ariaLabel="Add selected items to an interval"
                  onValueChange={(v) =>
                    bulkUpdate({ intervalId: v === "__none" ? null : v })
                  }
                  options={[
                    { value: "__none", label: "No interval" },
                    ...intervals.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />

                {/* Add tag — appends to each selected item's existing tags */}
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const tag = tagDraft.trim();
                    if (!tag) return;
                    addTagToSelected(tag);
                    setTagDraft("");
                  }}
                >
                  <input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    placeholder="Add tag"
                    aria-label="Add tag to selected items"
                    className="h-7 w-24 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </form>
              </>
            )}

            {canBulkDelete && (
              <>
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmBulkDelete(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={confirmBulkDelete}
        onOpenChange={(open) => {
          if (!open && !bulkDeleteMutation.isPending) setConfirmBulkDelete(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selectedCount} work item{selectedCount === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              This will permanently delete the selected work item
              {selectedCount === 1 ? "" : "s"}. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmBulkDelete(false)}
              disabled={bulkDeleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => bulkDeleteMutation.mutate(selectedIds)}
              disabled={bulkDeleteMutation.isPending}
            >
              {bulkDeleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DensityButton({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
        active
          ? "border-primary/50 bg-primary/10 text-primary"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
    </button>
  );
}

function BulkSelect({
  placeholder,
  ariaLabel,
  options,
  onValueChange,
}: {
  placeholder: string;
  ariaLabel: string;
  options: { value: string; label: string }[];
  onValueChange: (value: string) => void;
}) {
  return (
    <Select
      // Always-empty controlled value: the trigger stays a placeholder "action"
      // label rather than sticking on the last-picked option, so the same bulk
      // action can be re-applied.
      value=""
      onValueChange={(v) => {
        if (v) onValueChange(v as string);
      }}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className="h-7 text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function EditableInput({
  value,
  onChange,
  onSave,
  onCancel,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  type?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave();
          if (e.key === "Escape") onCancel();
        }}
        autoFocus
        className="h-7 w-full rounded-md border border-ring bg-transparent px-2 text-sm outline-none ring-2 ring-ring/30"
      />
      <button
        type="button"
        onClick={onSave}
        className="p-0.5 text-green-500 hover:text-green-400"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="p-0.5 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function TableViewSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-2 border-b">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-6 w-20" />
      </div>
      <div className="flex-1 p-4 space-y-2">
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
