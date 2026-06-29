"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
import { Loader2, Users } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";

type ProjectRole = "MANAGER" | "LEAD" | "MEMBER" | "VIEWER";

// ---------------------------------------------------------------------------
// Compliance helpers — inline pure functions (no prisma import)
// ---------------------------------------------------------------------------
type CacStatus = "active" | "pending" | "expired" | null;
type TrainingStatus = "complete" | "in_progress" | "incomplete" | null;
type AccessStatus = "granted" | "pending" | "revoked" | null;
type NdaStatus = "executed" | "pending" | "not_executed" | null;

function cacOk(s: CacStatus) { return s === "active"; }
function trainingOk(s: TrainingStatus) { return s === "complete"; }
function accessOk(s: AccessStatus) { return s === "granted"; }
function ndaOk(s: NdaStatus) { return s === "executed"; }

/** Return inline style color token for a status pill. */
function pillColor(ok: boolean, warn: boolean): string {
  if (ok)   return "var(--success, #16a34a)";
  if (warn)  return "var(--warning, #d97706)";
  return "var(--danger, #dc2626)";
}

function CacPill({ status }: { status: CacStatus }) {
  if (status === null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const ok   = status === "active";
  const warn = status === "pending";
  const label = status === "active" ? "Active" : status === "pending" ? "Pending" : "Expired";
  return (
    <span style={{ color: pillColor(ok, warn), fontWeight: 500 }}>{label}</span>
  );
}

function TrainingPill({ status }: { status: TrainingStatus }) {
  if (status === null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const ok   = status === "complete";
  const warn = status === "in_progress";
  const label = status === "complete" ? "Complete" : status === "in_progress" ? "In progress" : "Incomplete";
  return (
    <span style={{ color: pillColor(ok, warn), fontWeight: 500 }}>{label}</span>
  );
}

function AccessPill({ status }: { status: AccessStatus }) {
  if (status === null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const ok   = status === "granted";
  const warn = status === "pending";
  const label = status === "granted" ? "Granted" : status === "pending" ? "Pending" : "Revoked";
  return (
    <span style={{ color: pillColor(ok, warn), fontWeight: 500 }}>{label}</span>
  );
}

function NdaPill({ status }: { status: NdaStatus }) {
  if (status === null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const ok   = status === "executed";
  const warn = status === "pending";
  const label = status === "executed" ? "Executed" : status === "pending" ? "Pending" : "Not executed";
  return (
    <span style={{ color: pillColor(ok, warn), fontWeight: 500 }}>{label}</span>
  );
}

function OverallPill({ compliant }: { compliant: boolean }) {
  if (compliant) {
    return (
      <span
        style={{
          color: "var(--success, #16a34a)",
          background: "color-mix(in srgb, var(--success, #16a34a) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--success, #16a34a) 30%, transparent)",
          borderRadius: "9999px",
          padding: "2px 8px",
          fontSize: "0.75rem",
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        Compliant
      </span>
    );
  }
  return (
    <span
      style={{
        color: "var(--text-muted)",
        background: "color-mix(in srgb, var(--text-muted) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--text-muted) 25%, transparent)",
        borderRadius: "9999px",
        padding: "2px 8px",
        fontSize: "0.75rem",
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      Pending
    </span>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StaffRow {
  id: string;
  userId: string;
  name: string;
  role: ProjectRole;
  allocationPercent: number | null;
  laborCategory: string | null;
  clearance: string | null;
  employmentType: string | null;
  costRate: number | null;
  // compliance
  onContract: boolean;
  cacStatus: CacStatus;
  cacExpiry: string | null;
  trainingStatus: TrainingStatus;
  accessStatus: AccessStatus;
  ndaStatus: NdaStatus;
  complianceNotes: string | null;
  compliant: boolean;
}

const ROLE_OPTIONS: { value: ProjectRole; label: string }[] = [
  { value: "MANAGER", label: "Manager" },
  { value: "LEAD",    label: "Lead"    },
  { value: "MEMBER",  label: "Member"  },
  { value: "VIEWER",  label: "Viewer"  },
];

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------
interface EditForm {
  role: ProjectRole;
  allocationPercent: string;
  // compliance
  onContract: boolean;
  cacStatus: string;
  cacExpiry: string;
  trainingStatus: string;
  accessStatus: string;
  ndaStatus: string;
  complianceNotes: string;
}

function rowToForm(row: StaffRow): EditForm {
  return {
    role: row.role,
    allocationPercent: row.allocationPercent != null ? String(row.allocationPercent) : "",
    onContract:       row.onContract ?? false,
    cacStatus:        row.cacStatus ?? "",
    cacExpiry:        row.cacExpiry ?? "",
    trainingStatus:   row.trainingStatus ?? "",
    accessStatus:     row.accessStatus ?? "",
    ndaStatus:        row.ndaStatus ?? "",
    complianceNotes:  row.complianceNotes ?? "",
  };
}

function formToBody(form: EditForm, currentRole: ProjectRole) {
  const parsed = form.allocationPercent.trim() === "" ? null : Number(form.allocationPercent);
  return {
    role:             form.role ?? currentRole,
    allocationPercent: parsed != null && !isNaN(parsed) ? parsed : null,
    onContract:       form.onContract,
    cacStatus:        form.cacStatus || null,
    cacExpiry:        form.cacExpiry || null,
    trainingStatus:   form.trainingStatus || null,
    accessStatus:     form.accessStatus || null,
    ndaStatus:        form.ndaStatus || null,
    complianceNotes:  form.complianceNotes || null,
  };
}

// ---------------------------------------------------------------------------
// Compliance summary header
// ---------------------------------------------------------------------------
interface ComplianceSummaryProps {
  staff: StaffRow[];
}

function ComplianceSummary({ staff }: ComplianceSummaryProps) {
  const total      = staff.length;
  const compliant  = staff.filter((r) => r.compliant).length;
  const pct        = total === 0 ? 0 : Math.round((compliant / total) * 100);
  const cacPending     = staff.filter((r) => !cacOk(r.cacStatus)).length;
  const trainingBad    = staff.filter((r) => !trainingOk(r.trainingStatus)).length;
  const accessPending  = staff.filter((r) => !accessOk(r.accessStatus)).length;
  const ndaBad         = staff.filter((r) => !ndaOk(r.ndaStatus)).length;

  const chipBase: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    padding: "8px 12px",
    borderRadius: "var(--radius, 6px)",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    minWidth: 90,
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        padding: "10px 14px",
        borderRadius: "var(--radius, 6px)",
        border: "1px solid var(--border)",
        background: "var(--surface)",
        alignItems: "center",
      }}
    >
      {/* Primary stat */}
      <div style={{ ...chipBase, border: "none", background: "none", padding: "0 8px 0 0", borderRight: "1px solid var(--border)", marginRight: 4 }}>
        <span style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text)", lineHeight: 1.1 }}>
          {pct}%
        </span>
        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
          fully compliant ({compliant}/{total})
        </span>
      </div>

      <div style={chipBase}>
        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: cacPending > 0 ? "var(--warning, #d97706)" : "var(--text-muted)" }}>
          {cacPending}
        </span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>CAC issues</span>
      </div>

      <div style={chipBase}>
        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: trainingBad > 0 ? "var(--warning, #d97706)" : "var(--text-muted)" }}>
          {trainingBad}
        </span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>Training incomplete</span>
      </div>

      <div style={chipBase}>
        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: accessPending > 0 ? "var(--warning, #d97706)" : "var(--text-muted)" }}>
          {accessPending}
        </span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>Access pending</span>
      </div>

      <div style={chipBase}>
        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: ndaBad > 0 ? "var(--warning, #d97706)" : "var(--text-muted)" }}>
          {ndaBad}
        </span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>NDAs not executed</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
interface StaffingTrackerProps {
  orgId: string;
  projectId: string;
}

export function StaffingTracker({ orgId, projectId }: StaffingTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/staffing`;
  const queryKey = useOrgQueryKey("staffing", projectId);
  const canEdit = usePermissions().can(Permission.PROJECT_UPDATE);

  const { data: staff = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<StaffRow[]>(apiBase),
  });

  const [filter, setFilter]   = useState("");
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [form, setForm]       = useState<EditForm>({
    role:             "MEMBER",
    allocationPercent: "",
    onContract:       false,
    cacStatus:        "",
    cacExpiry:        "",
    trainingStatus:   "",
    accessStatus:     "",
    ndaStatus:        "",
    complianceNotes:  "",
  });

  const patchMutation = useOrgMutation<StaffRow, Error, { memberId: string; body: ReturnType<typeof formToBody> }>({
    mutationFn: ({ memberId, body }) =>
      jsonFetch(`${apiBase}/${memberId}`, { method: "PATCH", body: JSON.stringify(body) }),
    invalidate: [["staffing", projectId]],
    onSuccess: () => setEditing(null),
    onError: (e) => notifyError(e, "Couldn't update the team member."),
  });

  const showCostRate = useMemo(() => staff.some((r) => r.costRate != null), [staff]);

  const view = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return staff;
    return staff.filter(
      (r) =>
        r.name.toLowerCase().includes(f) ||
        (r.laborCategory ?? "").toLowerCase().includes(f) ||
        (r.clearance ?? "").toLowerCase().includes(f),
    );
  }, [staff, filter]);

  function openEdit(row: StaffRow) {
    setForm(rowToForm(row));
    setEditing(row);
  }

  function handleSave() {
    if (!editing) return;
    patchMutation.mutate({
      memberId: editing.id,
      body: formToBody(form, editing.role),
    });
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-5xl p-6">
        <LoadError title="Couldn't load team members" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text)]">Team &amp; Staffing</h2>
        <p className="text-sm text-[var(--text-muted)]">
          {staff.length} team member{staff.length === 1 ? "" : "s"}
        </p>
      </div>

      {/* Compliance summary header */}
      {staff.length > 0 && <ComplianceSummary staff={staff} />}

      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by name, labor category, or clearance…"
        className="max-w-xs"
      />

      {view.length === 0 ? (
        <EmptyState
          icon={Users}
          title={filter ? "No matching members" : "No team members yet"}
          description={
            filter
              ? "Try a different filter."
              : "Add people to this project on the Members tab."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-3 py-2 font-medium">Person</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Labor category</th>
                <th className="px-3 py-2 font-medium">Clearance</th>
                <th className="px-3 py-2 font-medium">Allocation</th>
                {showCostRate && (
                  <th className="px-3 py-2 text-right font-medium">Cost rate</th>
                )}
                <th className="px-3 py-2 font-medium">CAC</th>
                <th className="px-3 py-2 font-medium">Training</th>
                <th className="px-3 py-2 font-medium">Access</th>
                <th className="px-3 py-2 font-medium">NDA</th>
                <th className="px-3 py-2 font-medium">Overall</th>
              </tr>
            </thead>
            <tbody>
              {view.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)]${canEdit ? " cursor-pointer" : ""}`}
                  onClick={canEdit ? () => openEdit(row) : undefined}
                >
                  <td className="px-3 py-2 font-medium text-[var(--text)]">{row.name}</td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">
                    {ROLE_OPTIONS.find((o) => o.value === row.role)?.label ?? row.role}
                  </td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">
                    {row.laborCategory ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">
                    {row.clearance ?? "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-[var(--text-muted)]">
                    {row.allocationPercent != null ? `${row.allocationPercent}%` : "—"}
                  </td>
                  {showCostRate && (
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">
                      {row.costRate != null
                        ? `$${row.costRate.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/hr`
                        : "—"}
                    </td>
                  )}
                  <td className="px-3 py-2"><CacPill status={row.cacStatus} /></td>
                  <td className="px-3 py-2"><TrainingPill status={row.trainingStatus} /></td>
                  <td className="px-3 py-2"><AccessPill status={row.accessStatus} /></td>
                  <td className="px-3 py-2"><NdaPill status={row.ndaStatus} /></td>
                  <td className="px-3 py-2"><OverallPill compliant={row.compliant} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit dialog */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
            <DialogDescription className="text-[var(--text-muted)]">
              Update role, allocation, and compliance for this team member.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {/* ── Existing fields ── */}
            <FormField label="Project role">
              {(p) => (
                <Select
                  value={form.role}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, role: (v ?? form.role) as ProjectRole }))
                  }
                >
                  <SelectTrigger {...p}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>

            <FormField label="Allocation %">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  max={100}
                  value={form.allocationPercent}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, allocationPercent: e.target.value }))
                  }
                  placeholder="e.g. 50"
                />
              )}
            </FormField>

            {/* ── Compliance fields ── */}
            <FormField label="On contract">
              {(p) => (
                <label
                  {...p}
                  style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.875rem" }}
                >
                  <input
                    type="checkbox"
                    checked={form.onContract}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, onContract: e.target.checked }))
                    }
                    style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
                  />
                  Active on contract
                </label>
              )}
            </FormField>

            <FormField label="CAC status">
              {(p) => (
                <Select
                  value={form.cacStatus}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, cacStatus: v ?? "" }))
                  }
                >
                  <SelectTrigger {...p}>
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="expired">Expired</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>

            <FormField label="CAC expiry">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.cacExpiry}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, cacExpiry: e.target.value }))
                  }
                />
              )}
            </FormField>

            <FormField label="Training status">
              {(p) => (
                <Select
                  value={form.trainingStatus}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, trainingStatus: v ?? "" }))
                  }
                >
                  <SelectTrigger {...p}>
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="complete">Complete</SelectItem>
                    <SelectItem value="in_progress">In progress</SelectItem>
                    <SelectItem value="incomplete">Incomplete</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>

            <FormField label="System access">
              {(p) => (
                <Select
                  value={form.accessStatus}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, accessStatus: v ?? "" }))
                  }
                >
                  <SelectTrigger {...p}>
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="granted">Granted</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="revoked">Revoked</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>

            <FormField label="NDA status">
              {(p) => (
                <Select
                  value={form.ndaStatus}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, ndaStatus: v ?? "" }))
                  }
                >
                  <SelectTrigger {...p}>
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="executed">Executed</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="not_executed">Not executed</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>

            <FormField label="Compliance notes">
              {(p) => (
                <textarea
                  {...p}
                  rows={3}
                  value={form.complianceNotes}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, complianceNotes: e.target.value }))
                  }
                  placeholder="Optional notes…"
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    borderRadius: "var(--radius, 6px)",
                    border: "1px solid var(--border)",
                    background: "var(--input, var(--surface))",
                    color: "var(--text)",
                    fontSize: "0.875rem",
                    resize: "vertical",
                    outline: "none",
                  }}
                />
              )}
            </FormField>

            <p className="text-xs text-[var(--text-muted)]">
              Add or remove people on the Members tab.
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditing(null)}
              disabled={patchMutation.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={patchMutation.isPending}>
              {patchMutation.isPending && (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-4 w-24" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
