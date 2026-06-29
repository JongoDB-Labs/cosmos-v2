"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { EmptyState } from "@/components/ui/empty-state";
import { Users } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { PmEntityDrawer, type PmField } from "@/components/pm-dashboard/pm-entity-drawer";

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

  const [filter, setFilter] = useState("");
  // The drawer is the primary row-detail view. We hold the open member's id so
  // the drawer's fields rebuild from the freshest cached row after an inline
  // PATCH.
  const [openMemberId, setOpenMemberId] = useState<string | null>(null);
  const openRow = openMemberId ? staff.find((r) => r.id === openMemberId) ?? null : null;

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

  // Build the drawer's inline-editable field list for the open member. Role,
  // allocation, and the compliance fields PATCH the staffing endpoint by key;
  // labor category / clearance / employment type / cost rate / overall are
  // derived or owned on the Members page and shown read-only.
  function staffFields(row: StaffRow): PmField[] {
    const out: PmField[] = [
      {
        key: "role",
        label: "Project role",
        type: "select",
        value: row.role,
        editable: canEdit,
        options: ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      },
      {
        key: "allocationPercent",
        label: "Allocation %",
        type: "number",
        value: row.allocationPercent,
        editable: canEdit,
        min: 0,
        max: 100,
      },
      {
        key: "onContract",
        label: "On contract",
        type: "select",
        value: row.onContract ? "true" : "false",
        editable: canEdit,
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
        coerce: (v) => v === "true",
      },
      {
        key: "cacStatus",
        label: "CAC status",
        type: "select",
        value: row.cacStatus,
        editable: canEdit,
        options: [
          { value: "active", label: "Active" },
          { value: "pending", label: "Pending" },
          { value: "expired", label: "Expired" },
        ],
        placeholder: "Select…",
      },
      {
        key: "cacExpiry",
        label: "CAC expiry",
        type: "date",
        value: row.cacExpiry,
        editable: canEdit,
      },
      {
        key: "trainingStatus",
        label: "Training status",
        type: "select",
        value: row.trainingStatus,
        editable: canEdit,
        options: [
          { value: "complete", label: "Complete" },
          { value: "in_progress", label: "In progress" },
          { value: "incomplete", label: "Incomplete" },
        ],
        placeholder: "Select…",
      },
      {
        key: "accessStatus",
        label: "System access",
        type: "select",
        value: row.accessStatus,
        editable: canEdit,
        options: [
          { value: "granted", label: "Granted" },
          { value: "pending", label: "Pending" },
          { value: "revoked", label: "Revoked" },
        ],
        placeholder: "Select…",
      },
      {
        key: "ndaStatus",
        label: "NDA status",
        type: "select",
        value: row.ndaStatus,
        editable: canEdit,
        options: [
          { value: "executed", label: "Executed" },
          { value: "pending", label: "Pending" },
          { value: "not_executed", label: "Not executed" },
        ],
        placeholder: "Select…",
      },
      {
        key: "complianceNotes",
        label: "Compliance notes",
        type: "textarea",
        value: row.complianceNotes,
        editable: canEdit,
        placeholder: "Optional notes…",
      },
      // ── Read-only — derived / owned on the Members page ──
      { key: "laborCategory", label: "Labor category", type: "text", value: row.laborCategory, editable: false },
      { key: "clearance", label: "Clearance", type: "text", value: row.clearance, editable: false },
      { key: "employmentType", label: "Employment type", type: "text", value: row.employmentType, editable: false },
    ];
    if (row.costRate != null) {
      out.push({
        key: "costRate",
        label: "Cost rate ($/hr)",
        type: "number",
        value: row.costRate,
        editable: false,
      });
    }
    out.push({
      key: "compliant",
      label: "Overall",
      type: "text",
      value: row.compliant ? "Compliant" : "Pending",
      editable: false,
    });
    return out;
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
                  className="cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)]"
                  onClick={() => setOpenMemberId(row.id)}
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

      {/* Detail drawer — issue-style: inline-editable fields + Comments + Activity.
          Replaces the old edit dialog as the primary row-detail view. */}
      {openRow && (
        <PmEntityDrawer
          key={openRow.id}
          orgId={orgId}
          projectId={projectId}
          subjectType="staff"
          subjectId={openRow.id}
          title={openRow.name}
          code={null}
          patchPath={`${apiBase}/${openRow.id}`}
          fields={staffFields(openRow)}
          open={openMemberId !== null}
          onOpenChange={(o) => !o && setOpenMemberId(null)}
          onSaved={() => void refetch()}
        />
      )}
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
