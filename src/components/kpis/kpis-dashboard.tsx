"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "@/components/charts/lazy-recharts";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  AlertTriangle,
  Gauge,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types — model the actual API responses (Prisma Kpi + KpiDataPoint), since
// the shared @/types/models may not carry these yet.
// ---------------------------------------------------------------------------

type KpiDirection = "UP_GOOD" | "DOWN_GOOD";

interface KpiDataPoint {
  id: string;
  kpiId: string;
  value: number;
  recordedAt: string;
  note: string | null;
  createdAt: string;
}

interface Kpi {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  description: string | null;
  unit: string;
  targetValue: number;
  currentValue: number;
  direction: KpiDirection;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  dataPoints: KpiDataPoint[];
}

interface KpisDashboardProps {
  orgId: string;
  projectId: string;
}

const DIRECTION_OPTIONS = [
  { value: "UP_GOOD", label: "Higher is better" },
  { value: "DOWN_GOOD", label: "Lower is better" },
] as const;

// ---------------------------------------------------------------------------
// Form shapes / helpers
// ---------------------------------------------------------------------------

interface KpiFormData {
  name: string;
  description: string;
  unit: string;
  targetValue: string;
  currentValue: string;
  direction: KpiDirection;
}

const emptyKpiForm: KpiFormData = {
  name: "",
  description: "",
  unit: "",
  targetValue: "0",
  currentValue: "0",
  direction: "UP_GOOD",
};

function kpiToForm(k: Kpi): KpiFormData {
  return {
    name: k.name,
    description: k.description ?? "",
    unit: k.unit,
    targetValue: String(k.targetValue),
    currentValue: String(k.currentValue),
    direction: k.direction,
  };
}

function toNumber(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatValue(value: number): string {
  // Trim float noise but keep meaningful decimals.
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * A KPI is "on target" when the current value meets/exceeds the target for
 * UP_GOOD metrics, or meets/undercuts it for DOWN_GOOD metrics.
 */
function isOnTarget(kpi: Pick<Kpi, "currentValue" | "targetValue" | "direction">): boolean {
  return kpi.direction === "UP_GOOD"
    ? kpi.currentValue >= kpi.targetValue
    : kpi.currentValue <= kpi.targetValue;
}

interface DataPointFormData {
  value: string;
  recordedAt: string;
  note: string;
}

const emptyDataPointForm: DataPointFormData = {
  value: "",
  recordedAt: "",
  note: "",
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function KpisDashboard({ orgId, projectId }: KpisDashboardProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/kpis`;

  const kpisQueryKey = useOrgQueryKey("kpis", projectId);
  const {
    data: kpis = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: kpisQueryKey,
    queryFn: () => jsonFetch<Kpi[]>(apiBase),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Kpi | null>(null);
  const [deleting, setDeleting] = useState<Kpi | null>(null);
  const [addingPointTo, setAddingPointTo] = useState<Kpi | null>(null);

  const [form, setForm] = useState<KpiFormData>(emptyKpiForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [pointForm, setPointForm] = useState<DataPointFormData>(emptyDataPointForm);
  const [pointErrors, setPointErrors] = useState<Record<string, string>>({});

  // -- mutations -----------------------------------------------------------

  const createMutation = useOrgMutation<Kpi, Error, KpiFormData>({
    mutationFn: (data) =>
      jsonFetch(apiBase, {
        method: "POST",
        body: JSON.stringify({
          name: data.name.trim(),
          description: data.description.trim() || null,
          unit: data.unit.trim(),
          targetValue: toNumber(data.targetValue),
          currentValue: toNumber(data.currentValue),
          direction: data.direction,
        }),
      }),
    invalidate: [["kpis", projectId]],
    onSuccess: () => {
      setCreateOpen(false);
      setForm(emptyKpiForm);
    },
    onError: (err) => notifyError(err, "Couldn't create the KPI."),
  });

  const updateMutation = useOrgMutation<Kpi, Error, { id: string; data: KpiFormData }>({
    mutationFn: ({ id, data }) =>
      jsonFetch(`${apiBase}/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: data.name.trim(),
          description: data.description.trim() || null,
          unit: data.unit.trim(),
          targetValue: toNumber(data.targetValue),
          currentValue: toNumber(data.currentValue),
          direction: data.direction,
        }),
      }),
    invalidate: [["kpis", projectId]],
    onSuccess: () => setEditing(null),
    onError: (err) => notifyError(err, "Couldn't update the KPI."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["kpis", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (err) => notifyError(err, "Couldn't delete the KPI."),
  });

  const addPointMutation = useOrgMutation<
    KpiDataPoint,
    Error,
    { kpiId: string; data: DataPointFormData }
  >({
    mutationFn: ({ kpiId, data }) =>
      jsonFetch(`${apiBase}/${kpiId}/data-points`, {
        method: "POST",
        body: JSON.stringify({
          value: toNumber(data.value),
          recordedAt: data.recordedAt ? new Date(data.recordedAt).toISOString() : undefined,
          note: data.note.trim() || null,
        }),
      }),
    invalidate: [["kpis", projectId]],
    onSuccess: () => {
      setAddingPointTo(null);
      setPointForm(emptyDataPointForm);
    },
    onError: (err) => notifyError(err, "Couldn't add the data point."),
  });

  // -- handlers ------------------------------------------------------------

  function openCreate() {
    setForm(emptyKpiForm);
    setFormErrors({});
    setCreateOpen(true);
  }

  function openEdit(kpi: Kpi) {
    setEditing(kpi);
    setForm(kpiToForm(kpi));
    setFormErrors({});
  }

  function openAddPoint(kpi: Kpi) {
    setAddingPointTo(kpi);
    setPointForm(emptyDataPointForm);
    setPointErrors({});
  }

  function validateKpi(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "Name is required";
    return next;
  }

  function validatePoint(): Record<string, string> {
    const next: Record<string, string> = {};
    if (pointForm.value.trim() === "" || !Number.isFinite(Number(pointForm.value))) {
      next.value = "Enter a number";
    }
    return next;
  }

  function handleCreate() {
    const next = validateKpi();
    setFormErrors(next);
    if (Object.keys(next).length > 0) return;
    createMutation.mutate(form);
  }

  function handleEdit() {
    if (!editing) return;
    const next = validateKpi();
    setFormErrors(next);
    if (Object.keys(next).length > 0) return;
    updateMutation.mutate({ id: editing.id, data: form });
  }

  function handleAddPoint() {
    if (!addingPointTo) return;
    const next = validatePoint();
    setPointErrors(next);
    if (Object.keys(next).length > 0) return;
    addPointMutation.mutate({ kpiId: addingPointTo.id, data: pointForm });
  }

  const submitting = createMutation.isPending || updateMutation.isPending;

  // -- render --------------------------------------------------------------

  if (isLoading) return <KpisSkeleton />;

  if (isError) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <LoadError
          title="Couldn't load KPIs"
          onRetry={() => {
            void refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">
            Key Performance Indicators
          </h2>
          <p className="text-sm text-[var(--text-muted)]">
            Track measurable outcomes for this project over time.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          New KPI
        </Button>
      </div>

      {kpis.length === 0 ? (
        <EmptyState
          icon={Gauge}
          title="No KPIs yet"
          description="Define a measurable target and record readings to see the trend over time."
          action={
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              New KPI
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {kpis.map((kpi) => (
            <KpiCard
              key={kpi.id}
              kpi={kpi}
              onEdit={() => openEdit(kpi)}
              onDelete={() => setDeleting(kpi)}
              onAddPoint={() => openAddPoint(kpi)}
            />
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New KPI</DialogTitle>
            <DialogDescription>
              Define a metric, its target, and whether higher or lower is better.
            </DialogDescription>
          </DialogHeader>
          <KpiForm form={form} setForm={setForm} errors={formErrors} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={submitting || !form.name.trim()}>
              {createMutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit KPI</DialogTitle>
            <DialogDescription>Update this KPI&apos;s definition and target.</DialogDescription>
          </DialogHeader>
          <KpiForm form={form} setForm={setForm} errors={formErrors} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={submitting || !form.name.trim()}>
              {updateMutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add data point dialog */}
      <Dialog
        open={addingPointTo !== null}
        onOpenChange={(open) => {
          if (!open) setAddingPointTo(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add data point</DialogTitle>
            <DialogDescription>
              Record a new reading for{" "}
              <span className="font-medium">{addingPointTo?.name}</span>. The latest reading
              becomes the current value.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <FormField label="Value" required error={pointErrors.value}>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="decimal"
                  value={pointForm.value}
                  onChange={(e) => {
                    setPointForm((f) => ({ ...f, value: e.target.value }));
                    setPointErrors((prev) => {
                      if (!prev.value) return prev;
                      const n = { ...prev };
                      delete n.value;
                      return n;
                    });
                  }}
                  placeholder={addingPointTo?.unit ? `e.g. 42 ${addingPointTo.unit}` : "e.g. 42"}
                  autoFocus
                />
              )}
            </FormField>
            <FormField label="Date" hint="Defaults to now if left blank.">
              {(p) => (
                <Input
                  {...p}
                  type="datetime-local"
                  value={pointForm.recordedAt}
                  onChange={(e) =>
                    setPointForm((f) => ({ ...f, recordedAt: e.target.value }))
                  }
                />
              )}
            </FormField>
            <FormField label="Note">
              {(p) => (
                <Textarea
                  {...p}
                  value={pointForm.note}
                  onChange={(e) => setPointForm((f) => ({ ...f, note: e.target.value }))}
                  placeholder="Optional context for this reading"
                  rows={2}
                />
              )}
            </FormField>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddingPointTo(null)}
              disabled={addPointMutation.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleAddPoint} disabled={addPointMutation.isPending}>
              {addPointMutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" />
              Delete KPI
            </DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium">{deleting?.name}</span> and all its recorded data
              points. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) deleteMutation.mutate(deleting.id);
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

function KpiCard({
  kpi,
  onEdit,
  onDelete,
  onAddPoint,
}: {
  kpi: Kpi;
  onEdit: () => void;
  onDelete: () => void;
  onAddPoint: () => void;
}) {
  const onTarget = isOnTarget(kpi);
  const delta = kpi.currentValue - kpi.targetValue;
  const deltaColor = onTarget
    ? "var(--status-done-text, var(--status-done))"
    : "var(--status-blocked-text, var(--status-blocked))";

  const DeltaIcon =
    delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;

  const chartData = kpi.dataPoints.map((dp) => ({
    t: new Date(dp.recordedAt).getTime(),
    value: dp.value,
  }));

  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-[var(--text)]">{kpi.name}</h3>
          {kpi.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-[var(--text-muted)]">
              {kpi.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-xs" onClick={onAddPoint} title="Add data point">
            <Plus className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onEdit} title="Edit KPI">
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onDelete} title="Delete KPI">
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold tabular-nums text-[var(--text)]">
            {formatValue(kpi.currentValue)}
          </span>
          {kpi.unit && (
            <span className="text-sm text-[var(--text-muted)]">{kpi.unit}</span>
          )}
        </div>
        <div className="flex flex-col items-end gap-0.5 text-right">
          <span
            className="inline-flex items-center gap-1 text-sm font-medium tabular-nums"
            style={{ color: deltaColor }}
          >
            <DeltaIcon className="size-3.5" aria-hidden />
            {delta >= 0 ? "+" : ""}
            {formatValue(delta)}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            Target {formatValue(kpi.targetValue)}
            {kpi.unit ? ` ${kpi.unit}` : ""}
          </span>
        </div>
      </div>

      <div className="h-32 w-full">
        {chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-[var(--border)] text-xs text-[var(--text-muted)]">
            No data points yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t: number) =>
                  new Date(t).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })
                }
                tick={{ fontSize: 10, fill: "var(--text-muted)" }}
                axisLine={false}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--text-muted)" }}
                axisLine={false}
                tickLine={false}
                width={32}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  fontSize: "12px",
                  color: "var(--text)",
                }}
                labelFormatter={(label) => new Date(Number(label)).toLocaleString()}
                formatter={(value) => [
                  `${formatValue(Number(value))}${kpi.unit ? ` ${kpi.unit}` : ""}`,
                  kpi.name,
                ]}
              />
              <ReferenceLine
                y={kpi.targetValue}
                stroke="var(--text-muted)"
                strokeDasharray="4 4"
                strokeWidth={1}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--primary)"
                strokeWidth={2}
                dot={{ r: 2, fill: "var(--primary)" }}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared KPI form (create + edit)
// ---------------------------------------------------------------------------

function KpiForm({
  form,
  setForm,
  errors,
}: {
  form: KpiFormData;
  setForm: React.Dispatch<React.SetStateAction<KpiFormData>>;
  errors: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-4 py-2">
      <FormField label="Name" required error={errors.name}>
        {(p) => (
          <Input
            {...p}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Monthly active users"
            autoFocus
          />
        )}
      </FormField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Unit">
          {(p) => (
            <Input
              {...p}
              value={form.unit}
              onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
              placeholder="e.g. %, users, ms"
            />
          )}
        </FormField>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" id="kpi-direction-label">
            Direction
          </label>
          <Select
            value={form.direction}
            onValueChange={(val) =>
              setForm((f) => ({ ...f, direction: (val as KpiDirection) ?? "UP_GOOD" }))
            }
          >
            <SelectTrigger className="w-full" aria-labelledby="kpi-direction-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIRECTION_OPTIONS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Target value">
          {(p) => (
            <Input
              {...p}
              type="number"
              inputMode="decimal"
              value={form.targetValue}
              onChange={(e) => setForm((f) => ({ ...f, targetValue: e.target.value }))}
              placeholder="0"
            />
          )}
        </FormField>

        <FormField label="Current value" hint="Updated automatically by data points.">
          {(p) => (
            <Input
              {...p}
              type="number"
              inputMode="decimal"
              value={form.currentValue}
              onChange={(e) => setForm((f) => ({ ...f, currentValue: e.target.value }))}
              placeholder="0"
            />
          )}
        </FormField>
      </div>

      <FormField label="Description">
        {(p) => (
          <Textarea
            {...p}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="What does this KPI measure, and why does it matter?"
            rows={2}
          />
        )}
      </FormField>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function KpisSkeleton() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-4 rounded-[var(--radius)] border border-[var(--border)] p-5"
          >
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-32 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
