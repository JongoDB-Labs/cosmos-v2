"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { computeRiskScore, riskLevelFromScore, type RiskLevel } from "@/lib/pm/risk";
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
import { Loader2, Plus, Pencil, Trash2, ShieldAlert, AlertTriangle } from "lucide-react";

type RiskStatus = "OPEN" | "MONITORING" | "MITIGATED" | "CLOSED" | "ESCALATED";

interface BranchLite {
  id: string;
  code: string;
  name: string;
}
interface Risk {
  id: string;
  code: string;
  title: string;
  description: string | null;
  category: string | null;
  branchId: string | null;
  programBranch: BranchLite | null;
  likelihood: number;
  impact: number;
  score: number;
  level: RiskLevel;
  owner: string | null;
  mitigation: string | null;
  contingency: string | null;
  status: RiskStatus;
  trend: string | null;
  escalate: boolean;
  targetDate: string | null;
  dateIdentified: string | null;
}

interface RiskTrackerProps {
  orgId: string;
  projectId: string;
  branches: BranchLite[];
}

const STATUS_OPTIONS: RiskStatus[] = ["OPEN", "MONITORING", "MITIGATED", "CLOSED", "ESCALATED"];
const CATEGORY_OPTIONS = ["Schedule", "Cost", "Technical", "Security", "Resource", "Compliance", "External"];
const TREND_OPTIONS = ["↑ Increasing", "→ Stable", "↓ Decreasing"];

const STATUS_LABEL: Record<RiskStatus, string> = {
  OPEN: "Open",
  MONITORING: "Monitoring",
  MITIGATED: "Mitigated",
  CLOSED: "Closed",
  ESCALATED: "Escalated",
};
const LEVEL_META: Record<RiskLevel, { label: string; color: string }> = {
  CRITICAL: { label: "Critical", color: "var(--status-blocked, #dc2626)" },
  HIGH: { label: "High", color: "#ea580c" },
  MEDIUM: { label: "Medium", color: "var(--status-warn, #d97706)" },
  LOW: { label: "Low", color: "var(--text-muted, #6b7280)" },
};

interface RiskForm {
  title: string;
  description: string;
  category: string;
  branchId: string;
  likelihood: number;
  impact: number;
  owner: string;
  mitigation: string;
  contingency: string;
  status: RiskStatus;
  trend: string;
  escalate: boolean;
  targetDate: string;
  dateIdentified: string;
}

const emptyForm: RiskForm = {
  title: "",
  description: "",
  category: "Technical",
  branchId: "",
  likelihood: 3,
  impact: 3,
  owner: "",
  mitigation: "",
  contingency: "",
  status: "OPEN",
  trend: "→ Stable",
  escalate: false,
  targetDate: "",
  dateIdentified: "",
};

function toDateInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}
function riskToForm(r: Risk): RiskForm {
  return {
    title: r.title,
    description: r.description ?? "",
    category: r.category ?? "Technical",
    branchId: r.branchId ?? "",
    likelihood: r.likelihood,
    impact: r.impact,
    owner: r.owner ?? "",
    mitigation: r.mitigation ?? "",
    contingency: r.contingency ?? "",
    status: r.status,
    trend: r.trend ?? "→ Stable",
    escalate: r.escalate,
    targetDate: toDateInput(r.targetDate),
    dateIdentified: toDateInput(r.dateIdentified),
  };
}
function formToBody(f: RiskForm) {
  return {
    title: f.title.trim(),
    description: f.description.trim() || null,
    category: f.category || null,
    branchId: f.branchId || null,
    likelihood: f.likelihood,
    impact: f.impact,
    owner: f.owner.trim() || null,
    mitigation: f.mitigation.trim() || null,
    contingency: f.contingency.trim() || null,
    status: f.status,
    trend: f.trend || null,
    escalate: f.escalate,
    targetDate: f.targetDate ? new Date(f.targetDate).toISOString() : null,
    dateIdentified: f.dateIdentified ? new Date(f.dateIdentified).toISOString() : null,
  };
}

type SortKey = "priority" | "code" | "level" | "status";

export function RiskTracker({ orgId, projectId, branches }: RiskTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/risks`;
  const queryKey = useOrgQueryKey("risks", projectId);
  const { data: risks = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<Risk[]>(apiBase),
  });

  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("priority");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Risk | null>(null);
  const [deleting, setDeleting] = useState<Risk | null>(null);
  const [form, setForm] = useState<RiskForm>(emptyForm);

  const createMutation = useOrgMutation<Risk, Error, RiskForm>({
    mutationFn: (f) => jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["risks", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the risk."),
  });
  const updateMutation = useOrgMutation<Risk, Error, { id: string; f: RiskForm }>({
    mutationFn: ({ id, f }) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["risks", projectId]],
    onSuccess: () => setEditing(null),
    onError: (e) => notifyError(e, "Couldn't update the risk."),
  });
  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["risks", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the risk."),
  });

  const view = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const rows = f
      ? risks.filter(
          (r) =>
            r.title.toLowerCase().includes(f) ||
            r.code.toLowerCase().includes(f) ||
            (r.owner ?? "").toLowerCase().includes(f) ||
            (r.programBranch?.name ?? "").toLowerCase().includes(f),
        )
      : risks.slice();
    const levelRank: Record<RiskLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    rows.sort((a, b) => {
      if (sort === "priority") return b.score - a.score;
      if (sort === "code") return a.code.localeCompare(b.code);
      if (sort === "level") return levelRank[a.level] - levelRank[b.level];
      return a.status.localeCompare(b.status);
    });
    return rows;
  }, [risks, filter, sort]);

  function openCreate() {
    setForm({ ...emptyForm, branchId: branches[0]?.id ?? "" });
    setCreateOpen(true);
  }
  function openEdit(r: Risk) {
    setForm(riskToForm(r));
    setEditing(r);
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load risks" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">Risk Register</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {risks.length} risk{risks.length === 1 ? "" : "s"} · score = likelihood × impact
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" /> New Risk
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title, ID, owner, branch…"
          className="max-w-xs"
        />
        <Select value={sort} onValueChange={(v) => setSort((v ?? "priority") as SortKey)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="priority">Sort: Priority (score)</SelectItem>
            <SelectItem value="code">Sort: Risk ID</SelectItem>
            <SelectItem value="level">Sort: Level</SelectItem>
            <SelectItem value="status">Sort: Status</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {view.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title={filter ? "No matching risks" : "No risks yet"}
          description={filter ? "Try a different filter." : "Log the first risk to start the register."}
          action={!filter ? <Button onClick={openCreate}><Plus className="size-4" /> New Risk</Button> : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-3 py-2 font-medium">ID</th>
                <th className="px-3 py-2 font-medium">Risk</th>
                <th className="px-3 py-2 font-medium">Branch</th>
                <th className="px-3 py-2 font-medium">Level</th>
                <th className="px-3 py-2 text-right font-medium">Score</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Esc.</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {view.map((r) => {
                const lm = LEVEL_META[r.level];
                return (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)]"
                    onClick={() => openEdit(r)}
                  >
                    <td className="px-3 py-2 font-mono text-xs text-[var(--text-muted)]">{r.code}</td>
                    <td className="max-w-xs truncate px-3 py-2 text-[var(--text)]">{r.title}</td>
                    <td className="px-3 py-2 text-xs text-[var(--text-muted)]">
                      {r.programBranch?.code ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Pill label={lm.label} color={lm.color} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--text)]">{r.score}</td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">{r.owner ?? "—"}</td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">{STATUS_LABEL[r.status]}</td>
                    <td className="px-3 py-2">
                      {r.escalate ? (
                        <span className="text-[10px] font-semibold uppercase text-[var(--status-blocked,#dc2626)]">
                          Yes
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete risk"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(r);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create */}
      <RiskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New Risk"
        form={form}
        setForm={setForm}
        branches={branches}
        pending={createMutation.isPending}
        onSubmit={() => createMutation.mutate(form)}
        submitLabel="Create"
      />
      {/* Edit */}
      <RiskDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing ? `Edit ${editing.code}` : "Edit Risk"}
        form={form}
        setForm={setForm}
        branches={branches}
        pending={updateMutation.isPending}
        onSubmit={() => editing && updateMutation.mutate({ id: editing.id, f: form })}
        submitLabel="Save"
      />
      {/* Delete confirm */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" /> Delete risk
            </DialogTitle>
            <DialogDescription>
              Permanently delete <span className="font-medium">{deleting?.code}</span> —{" "}
              {deleting?.title}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
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

function RiskDialog({
  open,
  onOpenChange,
  title,
  form,
  setForm,
  branches,
  pending,
  onSubmit,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  form: RiskForm;
  setForm: React.Dispatch<React.SetStateAction<RiskForm>>;
  branches: BranchLite[];
  pending: boolean;
  onSubmit: () => void;
  submitLabel: string;
}) {
  const score = computeRiskScore(form.likelihood, form.impact);
  const level = riskLevelFromScore(score);
  const lm = LEVEL_META[level];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Score and level auto-calculate from likelihood × impact.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <FormField label="Risk title" required>
            {(p) => (
              <Input
                {...p}
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Short descriptive title"
                autoFocus
              />
            )}
          </FormField>
          <FormField label="Description">
            {(p) => (
              <Textarea
                {...p}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Condition and potential consequence"
                rows={2}
              />
            )}
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <PickField label="Category" value={form.category} onChange={(v) => setForm((f) => ({ ...f, category: v }))} options={CATEGORY_OPTIONS} />
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Branch</label>
              <Select value={form.branchId} onValueChange={(v) => setForm((f) => ({ ...f, branchId: v ?? "" }))}>
                <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.code} {b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FormField label="Owner">
              {(p) => (
                <Input {...p} value={form.owner} onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))} placeholder="Accountable person" />
              )}
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <NumField label="Likelihood (1-5)" value={form.likelihood} onChange={(n) => setForm((f) => ({ ...f, likelihood: n }))} />
            <NumField label="Impact (1-5)" value={form.impact} onChange={(n) => setForm((f) => ({ ...f, impact: n }))} />
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Score</label>
              <div className="flex h-9 items-center text-lg font-semibold tabular-nums text-[var(--text)]">{score}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Level</label>
              <div className="flex h-9 items-center"><Pill label={lm.label} color={lm.color} /></div>
            </div>
          </div>

          <FormField label="Mitigation strategy">
            {(p) => (
              <Textarea {...p} value={form.mitigation} onChange={(e) => setForm((f) => ({ ...f, mitigation: e.target.value }))} placeholder="Actions to reduce likelihood or impact" rows={2} />
            )}
          </FormField>
          <FormField label="Contingency plan">
            {(p) => (
              <Textarea {...p} value={form.contingency} onChange={(e) => setForm((f) => ({ ...f, contingency: e.target.value }))} placeholder="Response if the risk materializes" rows={2} />
            )}
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PickField label="Status" value={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v as RiskStatus }))} options={STATUS_OPTIONS} labelFor={(v) => STATUS_LABEL[v as RiskStatus]} />
            <PickField label="Trend" value={form.trend} onChange={(v) => setForm((f) => ({ ...f, trend: v }))} options={TREND_OPTIONS} />
            <FormField label="Date identified">
              {(p) => (
                <Input {...p} type="date" value={form.dateIdentified} onChange={(e) => setForm((f) => ({ ...f, dateIdentified: e.target.value }))} />
              )}
            </FormField>
            <FormField label="Target resolution">
              {(p) => (
                <Input {...p} type="date" value={form.targetDate} onChange={(e) => setForm((f) => ({ ...f, targetDate: e.target.value }))} />
              )}
            </FormField>
          </div>

          <label className="flex items-center gap-2 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={form.escalate}
              onChange={(e) => setForm((f) => ({ ...f, escalate: e.target.checked }))}
              className="size-4 accent-[var(--primary)]"
            />
            Escalate to customer (surfaces in the Government view)
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={pending || !form.title.trim()}>
            {pending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickField({
  label,
  value,
  onChange,
  options,
  labelFor,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  labelFor?: (v: string) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>{labelFor ? labelFor(o) : o}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      <Select value={String(value)} onValueChange={(v) => { if (v != null) onChange(Number(v)); }}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {[1, 2, 3, 4, 5].map((n) => (
            <SelectItem key={n} value={String(n)}>{n}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {label}
    </span>
  );
}

function TableSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
