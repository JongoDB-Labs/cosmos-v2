"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
  Pencil,
  Trash2,
  Clock,
  Calendar,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";

interface SavedReport {
  id: string;
  orgId: string;
  createdById: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  schedule: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReportsManagerProps {
  orgId: string;
}

const REPORT_TYPES = [
  { value: "sprint_velocity", label: "Sprint Velocity" },
  { value: "portfolio_summary", label: "Portfolio Summary" },
  { value: "burndown", label: "Burndown" },
  { value: "team_workload", label: "Team Workload" },
  { value: "completion_trend", label: "Completion Trend" },
];

const TYPE_COLORS: Record<string, string> = {
  sprint_velocity:
    "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  portfolio_summary:
    "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  burndown:
    "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  team_workload:
    "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  completion_trend:
    "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
};

interface ReportFormData {
  name: string;
  type: string;
  config: string;
  schedule: string;
}

const emptyForm: ReportFormData = {
  name: "",
  type: "sprint_velocity",
  config: "{}",
  schedule: "",
};

export function ReportsManager({ orgId }: ReportsManagerProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [form, setForm] = useState<ReportFormData>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const reportsKey = useOrgQueryKey("analytics", "reports");
  const {
    data: reports = [],
    isLoading: loading,
    isError,
    refetch,
  } = useQuery({
    queryKey: reportsKey,
    queryFn: async () => {
      const data = await jsonFetch<
        SavedReport[] | { reports: SavedReport[] }
      >(`/api/v1/orgs/${orgId}/analytics/reports`);
      return Array.isArray(data) ? data : data.reports || [];
    },
  });

  function parseConfig(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  const createMutation = useOrgMutation<SavedReport, Error, ReportFormData>({
    mutationFn: (f) =>
      jsonFetch(`/api/v1/orgs/${orgId}/analytics/reports`, {
        method: "POST",
        body: JSON.stringify({
          name: f.name,
          type: f.type,
          config: parseConfig(f.config),
          schedule: f.schedule || null,
        }),
      }),
    invalidate: [["analytics", "reports"]],
    onSuccess: () => {
      setCreateOpen(false);
      setForm(emptyForm);
    },
    onError: (err) => notifyError(err, "Couldn't create the report."),
  });

  const editMutation = useOrgMutation<
    SavedReport,
    Error,
    { id: string; f: ReportFormData }
  >({
    mutationFn: ({ id, f }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/analytics/reports/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: f.name,
          type: f.type,
          config: parseConfig(f.config),
          schedule: f.schedule || null,
        }),
      }),
    invalidate: [["analytics", "reports"]],
    onSuccess: () => {
      setEditOpen(false);
      setEditingId(null);
      setForm(emptyForm);
    },
    onError: (err) => notifyError(err, "Couldn't save the report."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/analytics/reports/${id}`, {
        method: "DELETE",
      }),
    invalidate: [["analytics", "reports"]],
    onSuccess: () => {
      setDeleteOpen(false);
      setDeletingId(null);
    },
    onError: (err) => notifyError(err, "Couldn't delete the report."),
  });

  const saving =
    createMutation.isPending ||
    editMutation.isPending ||
    deleteMutation.isPending;

  const handleCreate = () => {
    createMutation.mutate(form);
  };

  const handleEdit = () => {
    if (!editingId) return;
    editMutation.mutate({ id: editingId, f: form });
  };

  const openEdit = (report: SavedReport) => {
    setEditingId(report.id);
    setForm({
      name: report.name,
      type: report.type,
      config: JSON.stringify(report.config, null, 2),
      schedule: report.schedule ?? "",
    });
    setEditOpen(true);
  };

  const handleDelete = () => {
    if (!deletingId) return;
    deleteMutation.mutate(deletingId);
  };

  const openDelete = (id: string) => {
    setDeletingId(id);
    setDeleteOpen(true);
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "-";
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const getTypeLabel = (type: string) =>
    REPORT_TYPES.find((t) => t.value === type)?.label ?? type;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
        {/* Title/subtitle owned by the page shell (PageShell). */}
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger
            render={
              <Button>
                <Plus className="size-4" />
                New Report
              </Button>
            }
          />
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create Report</DialogTitle>
            </DialogHeader>
            <ReportForm form={form} onChange={setForm} />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={saving || !form.name.trim()}
              >
                {saving ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <LoadError
          onRetry={() => {
            refetch();
          }}
        />
      ) : reports.length === 0 ? (
        <EmptyState
          title="No saved reports yet"
          description="Build a report to track key metrics or schedule recurring summaries."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              Create a Report
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                    Name
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                    Type
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                    Schedule
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                    Last Run
                  </th>
                  <th className="text-right py-3 px-4 font-medium text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr
                    key={report.id}
                    className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                  >
                    <td className="py-3 px-4 font-medium">{report.name}</td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TYPE_COLORS[report.type] ?? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"}`}
                      >
                        {getTypeLabel(report.type)}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {report.schedule ? (
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Clock className="size-3" />
                          <code className="font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded">
                            {report.schedule}
                          </code>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {report.lastRunAt ? (
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Calendar className="size-3" />
                          {formatDate(report.lastRunAt)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Never</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => openEdit(report)}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => openDelete(report.id)}
                        >
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Report</DialogTitle>
          </DialogHeader>
          <ReportForm form={form} onChange={setForm} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditOpen(false);
                setEditingId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEdit}
              disabled={saving || !form.name.trim()}
            >
              {saving ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Report</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete this report? This action cannot be
            undone.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteOpen(false);
                setDeletingId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={saving}
            >
              {saving ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReportForm({
  form,
  onChange,
}: {
  form: ReportFormData;
  onChange: (form: ReportFormData) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="report-name">Name</Label>
        <Input
          id="report-name"
          placeholder="e.g., Weekly Sprint Summary"
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Type</Label>
        <Select
          value={form.type}
          onValueChange={(val) => onChange({ ...form, type: val ?? form.type })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REPORT_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="report-config">Configuration (JSON)</Label>
        <Textarea
          id="report-config"
          className="font-mono text-xs"
          placeholder="{}"
          value={form.config}
          onChange={(e) => onChange({ ...form, config: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="report-schedule">Schedule (cron expression, optional)</Label>
        <Input
          id="report-schedule"
          placeholder="e.g., 0 9 * * 1"
          value={form.schedule}
          onChange={(e) => onChange({ ...form, schedule: e.target.value })}
        />
        <p className="text-[11px] text-muted-foreground">
          Leave empty for manual-only runs. Example: 0 9 * * 1 = every Monday at 9am
        </p>
      </div>
    </div>
  );
}
