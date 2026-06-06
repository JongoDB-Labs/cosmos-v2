"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Clock,
  List,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Send,
  Pencil,
  Trash2,
  Filter,
} from "lucide-react";
import type { TimeEntry } from "@/types/models";
import { notifyError } from "@/lib/errors/notify";

interface Project {
  id: string;
  name: string;
  key: string;
}

interface TimeTrackerProps {
  orgId: string;
}

type ViewMode = "week" | "list";

const STATUS_COLORS: Record<TimeEntry["status"], string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  SUBMITTED: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  APPROVED: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  REJECTED: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

const BILLABLE_LABELS: Record<TimeEntry["billableType"], string> = {
  BILLABLE: "Billable",
  NON_BILLABLE: "Non-Billable",
  INTERNAL: "Internal",
};

function getWeekDates(baseDate: Date): Date[] {
  const start = new Date(baseDate);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    dates.push(d);
  }
  return dates;
}

function toDateString(d: Date): string {
  return d.toISOString().split("T")[0];
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface EntryFormData {
  date: string;
  hours: string;
  projectId: string;
  description: string;
  billableType: TimeEntry["billableType"];
  tags: string;
}

const emptyForm: EntryFormData = {
  date: toDateString(new Date()),
  hours: "",
  projectId: "",
  description: "",
  billableType: "BILLABLE",
  tags: "",
};

export function TimeTracker({ orgId }: TimeTrackerProps) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<ViewMode>("week");
  const [weekBase, setWeekBase] = useState<Date>(new Date());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [form, setForm] = useState<EntryFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [filterBillable, setFilterBillable] = useState<string>("ALL");
  const [showFilters, setShowFilters] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/projects`);
        if (res.ok) {
          const data = await res.json();
          setProjects(Array.isArray(data) ? data : data.projects || []);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [orgId]);

  const weekDates = getWeekDates(weekBase);
  const weekStart = toDateString(weekDates[0]);
  const weekEnd = toDateString(weekDates[6]);

  const [refreshKey, setRefreshKey] = useState(0);

  // Guards against stale responses: only the most recent load() applies state,
  // so a slow request for a previous week/filter can't clobber the current one.
  const reqRef = useRef(0);
  const load = useCallback(async () => {
    const token = ++reqRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams();
      if (view === "week") {
        params.set("startDate", weekStart);
        params.set("endDate", weekEnd);
      }
      if (filterStatus !== "ALL") params.set("status", filterStatus);
      if (filterBillable !== "ALL") params.set("billableType", filterBillable);
      const res = await fetch(`/api/v1/orgs/${orgId}/time-entries?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (reqRef.current !== token) return;
      // GET /time-entries returns `success({ data, total })` → the body is
      // `{ data: TimeEntry[], total }`. Read `.data` (raw fetch, so jsonFetch's
      // single-key unwrap doesn't apply). The Array/`.entries` fallbacks keep
      // older/alternate shapes working. (Reading `.entries` was the bug: it's
      // always undefined → the list rendered EMPTY in both week and list views.)
      setEntries(
        Array.isArray(data) ? data : (data.data ?? data.entries ?? []),
      );
    } catch {
      if (reqRef.current === token) setLoadError(true);
    } finally {
      if (reqRef.current === token) setLoading(false);
    }
  }, [orgId, view, weekStart, weekEnd, filterStatus, filterBillable, refreshKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = {
        date: form.date,
        hours: parseFloat(form.hours) || 0,
        projectId: form.projectId || null,
        description: form.description,
        billableType: form.billableType,
        tags: form.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };

      const url = editingEntry
        ? `/api/v1/orgs/${orgId}/time-entries/${editingEntry.id}`
        : `/api/v1/orgs/${orgId}/time-entries`;
      const method = editingEntry ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Failed to save time entry.");
      setDialogOpen(false);
      setEditingEntry(null);
      setForm(emptyForm);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't save the time entry.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/time-entries/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete time entry.");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't delete the time entry.");
    }
  };

  const handleSubmit = async (id: string) => {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/time-entries/${id}/submit`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to submit time entry.");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't submit the time entry for approval.");
    }
  };

  const openCreate = (date?: string) => {
    setEditingEntry(null);
    setForm({ ...emptyForm, date: date || toDateString(new Date()) });
    setDialogOpen(true);
  };

  const openEdit = (entry: TimeEntry) => {
    setEditingEntry(entry);
    setForm({
      date: entry.date.split("T")[0],
      hours: String(entry.hours),
      projectId: entry.projectId || "",
      description: entry.description,
      billableType: entry.billableType,
      tags: entry.tags.join(", "),
    });
    setDialogOpen(true);
  };

  const navigateWeek = (direction: number) => {
    const next = new Date(weekBase);
    next.setDate(next.getDate() + direction * 7);
    setWeekBase(next);
  };

  const getEntriesForDate = (date: string): TimeEntry[] => {
    return entries.filter((e) => e.date.startsWith(date));
  };

  const getDayTotal = (date: string): number => {
    return getEntriesForDate(date).reduce((sum, e) => sum + e.hours, 0);
  };

  const weekTotal = weekDates.reduce((sum, d) => sum + getDayTotal(toDateString(d)), 0);

  const groupedByRow = (() => {
    const map = new Map<string, Map<string, TimeEntry[]>>();
    entries.forEach((entry) => {
      const rowKey = `${entry.projectId || "none"}|${entry.description}`;
      if (!map.has(rowKey)) map.set(rowKey, new Map());
      const dateKey = entry.date.split("T")[0];
      const dateMap = map.get(rowKey)!;
      if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
      dateMap.get(dateKey)!.push(entry);
    });
    return map;
  })();

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
        {/* Title/subtitle are owned by the page shell (PageShell). This row
            only carries the view controls + actions, which wrap on mobile so
            the "Log Time" button never clips off the right edge. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border bg-muted/50 p-0.5">
            <button
              onClick={() => setView("week")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                view === "week"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <CalendarDays className="size-4" />
              Week
            </button>
            <button
              onClick={() => setView("list")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                view === "list"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <List className="size-4" />
              List
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowFilters(!showFilters)}>
            <Filter className="size-4" />
            Filters
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger
              render={
                <Button onClick={() => openCreate()}>
                  <Plus className="size-4" />
                  Log Time
                </Button>
              }
            />
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingEntry ? "Edit Time Entry" : "Log Time"}
                </DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="te-date">Date</Label>
                    <Input
                      id="te-date"
                      type="date"
                      value={form.date}
                      onChange={(e) => setForm({ ...form, date: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="te-hours">Hours</Label>
                    <Input
                      id="te-hours"
                      type="number"
                      step="0.25"
                      min="0"
                      max="24"
                      placeholder="0.00"
                      value={form.hours}
                      onChange={(e) => setForm({ ...form, hours: e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Project (optional)</Label>
                  <Select
                    value={form.projectId || "none"}
                    onValueChange={(val) =>
                      setForm({ ...form, projectId: !val || val === "none" ? "" : val })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a project" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— No project —</SelectItem>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.key} - {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="te-desc">Description</Label>
                  <Textarea
                    id="te-desc"
                    placeholder="What did you work on?"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Billable Type</Label>
                  <Select
                    value={form.billableType}
                    onValueChange={(val) =>
                      setForm({ ...form, billableType: val as TimeEntry["billableType"] })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BILLABLE">Billable</SelectItem>
                      <SelectItem value="NON_BILLABLE">Non-Billable</SelectItem>
                      <SelectItem value="INTERNAL">Internal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="te-tags">Tags (comma separated)</Label>
                  <Input
                    id="te-tags"
                    placeholder="design, review, frontend"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving || !form.hours}>
                  {saving ? "Saving..." : editingEntry ? "Update" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {showFilters && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Status</Label>
            <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v ?? "ALL")}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="DRAFT">Draft</SelectItem>
                <SelectItem value="SUBMITTED">Submitted</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Billable</Label>
            <Select value={filterBillable} onValueChange={(v) => setFilterBillable(v ?? "ALL")}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="BILLABLE">Billable</SelectItem>
                <SelectItem value="NON_BILLABLE">Non-Billable</SelectItem>
                <SelectItem value="INTERNAL">Internal</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : loadError ? (
        <LoadError onRetry={() => { void load(); }} />
      ) : view === "week" ? (
        <WeekView
          weekDates={weekDates}
          groupedByRow={groupedByRow}
          getDayTotal={getDayTotal}
          weekTotal={weekTotal}
          onNavigate={navigateWeek}
          onCellClick={openCreate}
          onEdit={openEdit}
          onSubmit={handleSubmit}
        />
      ) : (
        <ListView
          entries={entries}
          onEdit={openEdit}
          onSubmit={handleSubmit}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

function WeekView({
  weekDates,
  groupedByRow,
  getDayTotal,
  weekTotal,
  onNavigate,
  onCellClick,
  onEdit,
  onSubmit,
}: {
  weekDates: Date[];
  groupedByRow: Map<string, Map<string, TimeEntry[]>>;
  getDayTotal: (date: string) => number;
  weekTotal: number;
  onNavigate: (dir: number) => void;
  onCellClick: (date: string) => void;
  onEdit: (entry: TimeEntry) => void;
  onSubmit: (id: string) => void;
}) {
  const weekLabel = `${weekDates[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${weekDates[6].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => onNavigate(-1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-48 text-center text-sm font-medium">{weekLabel}</span>
          <Button variant="outline" size="icon" aria-label="Next week" onClick={() => onNavigate(1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Clock className="size-4 text-muted-foreground" />
          <span className="font-medium">{weekTotal.toFixed(2)}h total</span>
        </div>
      </div>

      <div className="overflow-x-auto scrollbar-x rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Description
              </th>
              {weekDates.map((d, i) => {
                const ds = toDateString(d);
                const isToday = ds === toDateString(new Date());
                return (
                  <th
                    key={ds}
                    className={`min-w-20 px-3 py-2 text-center font-medium ${
                      isToday ? "bg-primary/5 text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    <div>{DAY_LABELS[i]}</div>
                    <div className="text-xs font-normal">
                      {d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </div>
                  </th>
                );
              })}
              <th className="px-3 py-2 text-center font-medium text-muted-foreground">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {groupedByRow.size === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-3 py-12 text-center text-muted-foreground"
                >
                  No time entries this week. Click a cell to log time.
                </td>
              </tr>
            ) : (
              Array.from(groupedByRow.entries()).map(([rowKey, dateMap]) => {
                const desc = rowKey.split("|")[1] || "No description";
                let rowTotal = 0;
                return (
                  <tr key={rowKey} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="max-w-48 truncate px-3 py-2 font-medium">
                      {desc}
                    </td>
                    {weekDates.map((d) => {
                      const ds = toDateString(d);
                      const cellEntries = dateMap.get(ds) || [];
                      const cellTotal = cellEntries.reduce(
                        (s, e) => s + e.hours,
                        0
                      );
                      rowTotal += cellTotal;
                      const isToday = ds === toDateString(new Date());
                      return (
                        <td
                          key={ds}
                          className={`group relative min-w-20 px-3 py-2 text-center ${
                            isToday ? "bg-primary/5" : ""
                          }`}
                        >
                          {cellEntries.length > 0 ? (
                            <div className="flex flex-col items-center gap-1">
                              <span className="font-medium">{cellTotal.toFixed(2)}</span>
                              <div className="hidden gap-0.5 group-hover:flex">
                                {cellEntries.map((entry) => (
                                  <div key={entry.id} className="flex gap-0.5">
                                    {entry.status === "DRAFT" && (
                                      <button
                                        onClick={() => onEdit(entry)}
                                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                      >
                                        <Pencil className="size-3" />
                                      </button>
                                    )}
                                    {entry.status === "DRAFT" && (
                                      <button
                                        onClick={() => onSubmit(entry.id)}
                                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                      >
                                        <Send className="size-3" />
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={() => onCellClick(ds)}
                              aria-label={`Add time entry for ${ds}`}
                              className="flex size-full items-center justify-center rounded p-2 text-muted-foreground/30 hover:bg-muted hover:text-muted-foreground"
                            >
                              <Plus className="size-4" />
                            </button>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center font-semibold">
                      {rowTotal.toFixed(2)}
                    </td>
                  </tr>
                );
              })
            )}
            <tr className="border-t-2 bg-muted/50 font-semibold">
              <td className="px-3 py-2">Daily Totals</td>
              {weekDates.map((d) => {
                const ds = toDateString(d);
                const total = getDayTotal(ds);
                const isToday = ds === toDateString(new Date());
                return (
                  <td
                    key={ds}
                    className={`px-3 py-2 text-center ${isToday ? "bg-primary/5 text-foreground" : ""}`}
                  >
                    {total > 0 ? total.toFixed(2) : "-"}
                  </td>
                );
              })}
              <td className="px-3 py-2 text-center">{weekTotal.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ListView({
  entries,
  onEdit,
  onSubmit,
  onDelete,
}: {
  entries: TimeEntry[];
  onEdit: (entry: TimeEntry) => void;
  onSubmit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const sorted = [...entries].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  const columns: ColumnDef<TimeEntry>[] = [
    {
      accessorKey: "date",
      header: "Date",
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {new Date(row.original.date).toLocaleDateString()}
        </span>
      ),
    },
    {
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="block max-w-64 truncate">{row.original.description}</span>
      ),
    },
    {
      accessorKey: "hours",
      header: "Hours",
      cell: ({ row }) => (
        <span className="font-medium md:text-right md:block">
          {row.original.hours.toFixed(2)}
        </span>
      ),
    },
    {
      accessorKey: "billableType",
      header: "Billable",
      cell: ({ row }) => (
        <Badge variant="neutral" className="text-xs">
          {BILLABLE_LABELS[row.original.billableType]}
        </Badge>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[row.original.status]}`}
        >
          {row.original.status}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => {
        const entry = row.original;
        return (
          <div className="flex items-center justify-end gap-1">
            {entry.status === "DRAFT" && (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onEdit(entry)}
                >
                  <Pencil className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onSubmit(entry.id)}
                  title="Submit for approval"
                >
                  <Send className="size-3" />
                </Button>
                <Button
                  variant="destructive"
                  size="icon-xs"
                  onClick={() => onDelete(entry.id)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={sorted}
      emptyState={<EmptyState title="No time entries found." />}
    />
  );
}
