"use client";

import { useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey, useOrgSlug, orgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
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
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Clock,
  MinusCircle,
  CircleDot,
  X,
} from "lucide-react";

type ComplianceFramework =
  | "NIST_800_53"
  | "NIST_800_171"
  | "CMMC_L2"
  | "FEDRAMP_MOD"
  | "CUSTOM";

type ControlStatus =
  | "NOT_ASSESSED"
  | "IN_PROGRESS"
  | "IMPLEMENTED"
  | "PARTIALLY_IMPLEMENTED"
  | "NOT_APPLICABLE"
  | "FAILED";

interface ComplianceControl {
  id: string;
  orgId: string;
  framework: ComplianceFramework;
  controlId: string;
  title: string;
  description: string;
  status: ControlStatus;
  evidence: Record<string, unknown>[];
  notes: string;
  assessedAt: string | null;
  assessedById: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FrameworkSummary {
  framework: string;
  total: number;
  implemented: number;
  inProgress: number;
  failed: number;
  notAssessed: number;
  partiallyImplemented: number;
  notApplicable: number;
}

interface SummaryTotals {
  total: number;
  implemented: number;
  inProgress: number;
  failed: number;
  notAssessed: number;
  partiallyImplemented: number;
  notApplicable: number;
}

interface ComplianceSummary {
  frameworks: FrameworkSummary[];
  totals: SummaryTotals;
}

/**
 * The /compliance/summary endpoint currently returns
 *   { byFramework: Record<string, { total, byStatus, percentImplemented }>,
 *     overall: { total, implemented, inProgress, failed, notAssessed },
 *     overdueControls }
 * but earlier iterations of this component (and other callers) expected
 *   { frameworks: FrameworkSummary[], totals: SummaryTotals }.
 * Normalize both shapes into the latter so the UI never crashes on
 * `summary.totals.total` being undefined.
 */
type RawSummary =
  | ComplianceSummary
  | {
      byFramework?: Record<
        string,
        {
          total?: number;
          byStatus?: Record<string, number>;
        }
      >;
      overall?: Partial<SummaryTotals>;
    };

function emptyTotals(): SummaryTotals {
  return {
    total: 0,
    implemented: 0,
    inProgress: 0,
    failed: 0,
    notAssessed: 0,
    partiallyImplemented: 0,
    notApplicable: 0,
  };
}

function normalizeSummary(raw: RawSummary | null | undefined): ComplianceSummary {
  if (!raw || typeof raw !== "object") {
    return { frameworks: [], totals: emptyTotals() };
  }
  // Already in the expected shape.
  if ("totals" in raw && raw.totals) {
    return {
      frameworks: Array.isArray(raw.frameworks) ? raw.frameworks : [],
      totals: { ...emptyTotals(), ...raw.totals },
    };
  }
  // Server's `{ byFramework, overall }` shape — translate.
  const overall = ("overall" in raw && raw.overall) || {};
  const byFramework = ("byFramework" in raw && raw.byFramework) || {};
  const frameworks: FrameworkSummary[] = Object.entries(byFramework).map(
    ([fw, v]) => {
      const status = v?.byStatus ?? {};
      return {
        framework: fw,
        total: v?.total ?? 0,
        implemented: status.IMPLEMENTED ?? 0,
        inProgress: status.IN_PROGRESS ?? 0,
        failed: status.FAILED ?? 0,
        notAssessed: status.NOT_ASSESSED ?? 0,
        partiallyImplemented: status.PARTIALLY_IMPLEMENTED ?? 0,
        notApplicable: status.NOT_APPLICABLE ?? 0,
      };
    },
  );
  return {
    frameworks,
    totals: { ...emptyTotals(), ...overall },
  };
}

const FRAMEWORKS: { value: ComplianceFramework; label: string }[] = [
  { value: "NIST_800_53", label: "NIST 800-53" },
  { value: "NIST_800_171", label: "NIST 800-171" },
  { value: "CMMC_L2", label: "CMMC Level 2" },
  { value: "FEDRAMP_MOD", label: "FedRAMP Moderate" },
  { value: "CUSTOM", label: "Custom" },
];

const STATUSES: { value: ControlStatus; label: string }[] = [
  { value: "NOT_ASSESSED", label: "Not Assessed" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "IMPLEMENTED", label: "Implemented" },
  { value: "PARTIALLY_IMPLEMENTED", label: "Partially Implemented" },
  { value: "NOT_APPLICABLE", label: "Not Applicable" },
  { value: "FAILED", label: "Failed" },
];

function statusBadge(status: ControlStatus) {
  const map: Record<ControlStatus, { className: string; icon: React.ReactNode }> = {
    IMPLEMENTED: {
      className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
      icon: <CheckCircle2 className="size-3" />,
    },
    IN_PROGRESS: {
      className: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
      icon: <Clock className="size-3" />,
    },
    PARTIALLY_IMPLEMENTED: {
      className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      icon: <CircleDot className="size-3" />,
    },
    FAILED: {
      className: "bg-red-500/15 text-red-700 dark:text-red-400",
      icon: <AlertTriangle className="size-3" />,
    },
    NOT_APPLICABLE: {
      className: "bg-gray-500/15 text-gray-600 dark:text-gray-400",
      icon: <MinusCircle className="size-3" />,
    },
    NOT_ASSESSED: {
      className: "",
      icon: null,
    },
  };
  const cfg = map[status];
  return (
    <Badge variant="neutral" showDot={false} className={cn("gap-1", cfg.className)}>
      {cfg.icon}
      {STATUSES.find((s) => s.value === status)?.label ?? status}
    </Badge>
  );
}

function frameworkLabel(fw: ComplianceFramework) {
  return FRAMEWORKS.find((f) => f.value === fw)?.label ?? fw;
}

function frameworkBadge(fw: ComplianceFramework) {
  const colors: Record<ComplianceFramework, string> = {
    NIST_800_53: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
    NIST_800_171: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
    CMMC_L2: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
    FEDRAMP_MOD: "bg-teal-500/15 text-teal-700 dark:text-teal-400",
    CUSTOM: "bg-gray-500/15 text-gray-600 dark:text-gray-400",
  };
  return (
    <Badge className={cn("gap-1", colors[fw])}>
      {frameworkLabel(fw)}
    </Badge>
  );
}

interface ControlFormData {
  framework: ComplianceFramework;
  controlId: string;
  title: string;
  description: string;
  status: ControlStatus;
  dueDate: string;
  notes: string;
  evidence: Record<string, unknown>[];
}

const emptyForm: ControlFormData = {
  framework: "NIST_800_53",
  controlId: "",
  title: "",
  description: "",
  status: "NOT_ASSESSED",
  dueDate: "",
  notes: "",
  evidence: [],
};

function ControlFormDialog({
  open,
  onOpenChange,
  onSave,
  initial,
  mode,
  saving,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSave: (data: ControlFormData) => void;
  initial: ControlFormData;
  mode: "create" | "edit";
  saving: boolean;
}) {
  const [form, setForm] = useState<ControlFormData>(initial);
  const [evidenceInput, setEvidenceInput] = useState("");
  const [prevInitial, setPrevInitial] = useState(initial);
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setForm(initial);
  }

  function addEvidence() {
    if (!evidenceInput.trim()) return;
    try {
      const parsed = JSON.parse(evidenceInput);
      setForm((p) => ({ ...p, evidence: [...p.evidence, parsed] }));
      setEvidenceInput("");
    } catch {
      setForm((p) => ({
        ...p,
        evidence: [...p.evidence, { description: evidenceInput }],
      }));
      setEvidenceInput("");
    }
  }

  function removeEvidence(idx: number) {
    setForm((p) => ({ ...p, evidence: p.evidence.filter((_, i) => i !== idx) }));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Add Control" : "Edit Control"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Add a new compliance control to track."
              : "Update the compliance control details."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 max-h-[60vh] overflow-y-auto">
          <div className="grid gap-2">
            <Label>Framework</Label>
            <Select
              items={Object.fromEntries(FRAMEWORKS.map((fw) => [fw.value, fw.label]))}
              value={form.framework}
              onValueChange={(v) =>
                setForm((p) => ({ ...p, framework: v as ComplianceFramework }))
              }
            >
              <SelectTrigger className="w-full" aria-label="Framework">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FRAMEWORKS.map((fw) => (
                  <SelectItem key={fw.value} value={fw.value}>
                    {fw.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Control ID</Label>
            <Input
              value={form.controlId}
              onChange={(e) =>
                setForm((p) => ({ ...p, controlId: e.target.value }))
              }
              placeholder="e.g. AC-2"
            />
          </div>
          <div className="grid gap-2">
            <Label>Title</Label>
            <Input
              value={form.title}
              onChange={(e) =>
                setForm((p) => ({ ...p, title: e.target.value }))
              }
              placeholder="Control title"
            />
          </div>
          <div className="grid gap-2">
            <Label>Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) =>
                setForm((p) => ({ ...p, description: e.target.value }))
              }
              placeholder="Describe the control requirements"
            />
          </div>
          <div className="grid gap-2">
            <Label>Status</Label>
            <Select
              items={Object.fromEntries(STATUSES.map((s) => [s.value, s.label]))}
              value={form.status}
              onValueChange={(v) =>
                setForm((p) => ({ ...p, status: v as ControlStatus }))
              }
            >
              <SelectTrigger className="w-full" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Due Date</Label>
            <Input
              type="date"
              value={form.dueDate}
              onChange={(e) =>
                setForm((p) => ({ ...p, dueDate: e.target.value }))
              }
            />
          </div>
          {mode === "edit" && (
            <>
              <div className="grid gap-2">
                <Label>Notes</Label>
                <Textarea
                  value={form.notes}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, notes: e.target.value }))
                  }
                  placeholder="Assessment notes"
                />
              </div>
              <div className="grid gap-2">
                <Label>Evidence</Label>
                {form.evidence.length > 0 && (
                  <div className="space-y-1">
                    {form.evidence.map((ev, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1 text-xs"
                      >
                        <span className="flex-1 truncate font-mono">
                          {JSON.stringify(ev)}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeEvidence(idx)}
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    value={evidenceInput}
                    onChange={(e) => setEvidenceInput(e.target.value)}
                    placeholder='JSON or description text'
                    className="flex-1"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addEvidence();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addEvidence}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={!form.controlId || !form.title || saving}
            onClick={() => onSave(form)}
          >
            {saving ? "Saving..." : mode === "create" ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ComplianceDashboard({ orgId }: { orgId: string }) {
  const orgSlug = useOrgSlug();
  const qc = useQueryClient();
  const [filterFramework, setFilterFramework] = useState<string>("ALL");
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [createOpen, setCreateOpen] = useState(false);
  const [editControl, setEditControl] = useState<ComplianceControl | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ComplianceControl | null>(null);

  const summaryKey = useOrgQueryKey("compliance", "summary");
  const controlsKey = useOrgQueryKey("compliance", "controls");

  const [summaryQ, controlsQ] = useQueries({
    queries: [
      {
        queryKey: summaryKey,
        queryFn: async () => {
          const raw = await jsonFetch<RawSummary>(
            `/api/v1/orgs/${orgId}/compliance/summary`,
          );
          return normalizeSummary(raw);
        },
      },
      {
        queryKey: controlsKey,
        queryFn: async () => {
          const data = await jsonFetch<
            ComplianceControl[] | { controls?: ComplianceControl[]; data?: ComplianceControl[] }
          >(`/api/v1/orgs/${orgId}/compliance/controls`);
          if (Array.isArray(data)) return data;
          if (data && typeof data === "object") {
            return data.controls ?? data.data ?? [];
          }
          return [];
        },
      },
    ],
  });

  const summary = summaryQ.data ?? null;
  const controls = controlsQ.data ?? [];
  const loading = summaryQ.isLoading || controlsQ.isLoading;

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: orgQueryKey(orgSlug, "compliance") });
  }

  const createMutation = useOrgMutation<
    ComplianceControl,
    Error,
    ControlFormData
  >({
    mutationFn: (form) =>
      jsonFetch(`/api/v1/orgs/${orgId}/compliance/controls`, {
        method: "POST",
        body: JSON.stringify({
          framework: form.framework,
          controlId: form.controlId,
          title: form.title,
          description: form.description,
          status: form.status,
          dueDate: form.dueDate || null,
        }),
      }),
    onSuccess: () => {
      setCreateOpen(false);
      invalidateAll();
    },
    onError: (err) => notifyError(err, "Couldn't add the control."),
  });

  const editMutation = useOrgMutation<
    ComplianceControl,
    Error,
    { id: string; body: Record<string, unknown> }
  >({
    mutationFn: ({ id, body }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/compliance/controls/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setEditControl(null);
      invalidateAll();
    },
    onError: (err) => notifyError(err, "Couldn't save the control."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/compliance/controls/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidateAll();
    },
    onError: (err) => notifyError(err, "Couldn't delete the control."),
  });

  const saving =
    createMutation.isPending ||
    editMutation.isPending ||
    deleteMutation.isPending;

  function handleCreate(form: ControlFormData) {
    createMutation.mutate(form);
  }

  function handleEdit(form: ControlFormData) {
    if (!editControl) return;
    const body: Record<string, unknown> = {
      framework: form.framework,
      controlId: form.controlId,
      title: form.title,
      description: form.description,
      status: form.status,
      dueDate: form.dueDate || null,
      notes: form.notes,
      evidence: form.evidence,
    };
    if (form.status !== editControl.status) {
      body.assessedAt = new Date().toISOString();
    }
    editMutation.mutate({ id: editControl.id, body });
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id);
  }

  const filtered = controls.filter((c) => {
    if (filterFramework !== "ALL" && c.framework !== filterFramework) return false;
    if (filterStatus !== "ALL" && c.status !== filterStatus) return false;
    return true;
  });

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-end">
          <Skeleton className="h-8 w-32 rounded-lg" />
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (summaryQ.isError || controlsQ.isError) {
    return (
      <div className="space-y-6">
        <LoadError
          onRetry={() => {
            summaryQ.refetch();
            controlsQ.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <ShieldCheck className="size-5" />
            Compliance Dashboard
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Track compliance controls across frameworks
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4 mr-1" />
          Add Control
        </Button>
      </div>

      {summary && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground font-medium">Total</p>
              <p className="text-2xl font-bold mt-1">{summary.totals.total}</p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">Implemented</p>
              <p className="text-2xl font-bold mt-1 text-emerald-700 dark:text-emerald-400">
                {summary.totals.implemented}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-blue-700 dark:text-blue-400 font-medium">In Progress</p>
              <p className="text-2xl font-bold mt-1 text-blue-700 dark:text-blue-400">
                {summary.totals.inProgress}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-red-700 dark:text-red-400 font-medium">Failed</p>
              <p className="text-2xl font-bold mt-1 text-red-700 dark:text-red-400">
                {summary.totals.failed}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground font-medium">Not Assessed</p>
              <p className="text-2xl font-bold mt-1 text-muted-foreground">
                {summary.totals.notAssessed}
              </p>
            </div>
          </div>

          {summary.frameworks.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Framework Progress
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {summary.frameworks.map((fw) => {
                  const pct =
                    fw.total > 0
                      ? Math.round((fw.implemented / fw.total) * 100)
                      : 0;
                  return (
                    <div key={fw.framework} className="rounded-lg border bg-card p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium">
                          {frameworkLabel(fw.framework as ComplianceFramework)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {fw.implemented}/{fw.total} ({pct}%)
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-emerald-500 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            items={{
              ALL: "All Frameworks",
              ...Object.fromEntries(FRAMEWORKS.map((fw) => [fw.value, fw.label])),
            }}
            value={filterFramework}
            onValueChange={(v) => setFilterFramework(v ?? "ALL")}
          >
            <SelectTrigger className="w-44" aria-label="Filter by framework">
              <SelectValue placeholder="Framework" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Frameworks</SelectItem>
              {FRAMEWORKS.map((fw) => (
                <SelectItem key={fw.value} value={fw.value}>
                  {fw.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={{
              ALL: "All Statuses",
              ...Object.fromEntries(STATUSES.map((s) => [s.value, s.label])),
            }}
            value={filterStatus}
            onValueChange={(v) => setFilterStatus(v ?? "ALL")}
          >
            <SelectTrigger className="w-44" aria-label="Filter by status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {filtered.length} control{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                    Control ID
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                    Title
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                    Framework
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                    Assessed
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                    Due Date
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                      No controls found
                    </td>
                  </tr>
                ) : (
                  filtered.map((ctrl) => (
                    <tr
                      key={ctrl.id}
                      className="border-b last:border-b-0 hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-3 py-2 font-mono text-xs font-medium">
                        {ctrl.controlId}
                      </td>
                      <td className="px-3 py-2 max-w-[200px] truncate">
                        {ctrl.title}
                      </td>
                      <td className="px-3 py-2">{frameworkBadge(ctrl.framework)}</td>
                      <td className="px-3 py-2">{statusBadge(ctrl.status)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {ctrl.assessedAt
                          ? new Date(ctrl.assessedAt).toLocaleDateString()
                          : "-"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {ctrl.dueDate
                          ? new Date(ctrl.dueDate).toLocaleDateString()
                          : "-"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => setEditControl(ctrl)}
                          >
                            <Pencil className="size-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => setDeleteTarget(ctrl)}
                          >
                            <Trash2 className="size-3 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <ControlFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSave={handleCreate}
        initial={emptyForm}
        mode="create"
        saving={saving}
      />

      {editControl && (
        <ControlFormDialog
          open={!!editControl}
          onOpenChange={(v) => {
            if (!v) setEditControl(null);
          }}
          onSave={handleEdit}
          initial={{
            framework: editControl.framework,
            controlId: editControl.controlId,
            title: editControl.title,
            description: editControl.description,
            status: editControl.status,
            dueDate: editControl.dueDate
              ? editControl.dueDate.substring(0, 10)
              : "",
            notes: editControl.notes,
            evidence: editControl.evidence,
          }}
          mode="edit"
          saving={saving}
        />
      )}

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Control</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete control{" "}
              <span className="font-mono font-medium">
                {deleteTarget?.controlId}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={handleDelete}
            >
              {saving ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
