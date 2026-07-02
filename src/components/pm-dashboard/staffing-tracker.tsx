"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Users, Eye, UserCog, BadgeCheck } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { PmEntityDrawer, type PmField } from "@/components/pm-dashboard/pm-entity-drawer";
import { PmDataTable } from "@/components/pm-dashboard/pm-data-table";
import { bulkFanOut } from "@/lib/pm/bulk";
import type { ActionMenuGroup } from "@/components/ui/action-menu";

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

// Roles sort by seniority, not alphabetically (Manager → Lead → Member → Viewer).
const ROLE_RANK: Record<ProjectRole, number> = { MANAGER: 0, LEAD: 1, MEMBER: 2, VIEWER: 3 };

// Sortable columns (headers sort on click via the shared DataTable). Pure — no
// component state, so defined at module scope. Numeric columns (allocation, cost
// rate) carry an explicit `sortingFn` so the visual order is numeric, not string.
const STAFFING_COLUMNS: ColumnDef<StaffRow>[] = [
  {
    accessorKey: "name",
    header: "Person",
    cell: ({ row }) => <span className="font-medium text-[var(--text)]">{row.original.name}</span>,
  },
  {
    accessorKey: "role",
    header: "Role",
    sortingFn: (a, b) => ROLE_RANK[a.original.role] - ROLE_RANK[b.original.role],
    cell: ({ row }) => (
      <span className="text-[var(--text-muted)]">
        {ROLE_OPTIONS.find((o) => o.value === row.original.role)?.label ?? row.original.role}
      </span>
    ),
  },
  {
    id: "laborCategory",
    header: "Labor category",
    accessorFn: (r) => r.laborCategory ?? "",
    cell: ({ row }) => <span className="text-[var(--text-muted)]">{row.original.laborCategory ?? "—"}</span>,
  },
  {
    id: "clearance",
    header: "Clearance",
    accessorFn: (r) => r.clearance ?? "",
    cell: ({ row }) => <span className="text-[var(--text-muted)]">{row.original.clearance ?? "—"}</span>,
  },
  {
    id: "allocation",
    header: "Allocation",
    accessorFn: (r) => r.allocationPercent ?? -1,
    sortingFn: (a, b) => (a.original.allocationPercent ?? -1) - (b.original.allocationPercent ?? -1),
    cell: ({ row }) => (
      <span className="tabular-nums text-[var(--text-muted)]">
        {row.original.allocationPercent != null ? `${row.original.allocationPercent}%` : "—"}
      </span>
    ),
  },
  {
    id: "cac",
    header: "CAC",
    accessorFn: (r) => r.cacStatus ?? "",
    cell: ({ row }) => <CacPill status={row.original.cacStatus} />,
  },
  {
    id: "training",
    header: "Training",
    accessorFn: (r) => r.trainingStatus ?? "",
    cell: ({ row }) => <TrainingPill status={row.original.trainingStatus} />,
  },
  {
    id: "access",
    header: "Access",
    accessorFn: (r) => r.accessStatus ?? "",
    cell: ({ row }) => <AccessPill status={row.original.accessStatus} />,
  },
  {
    id: "nda",
    header: "NDA",
    accessorFn: (r) => r.ndaStatus ?? "",
    cell: ({ row }) => <NdaPill status={row.original.ndaStatus} />,
  },
  {
    id: "overall",
    header: "Overall",
    accessorFn: (r) => (r.compliant ? 1 : 0),
    cell: ({ row }) => <OverallPill compliant={row.original.compliant} />,
  },
];

// Cost rate is sensitive — only present when a finance-cleared caller loaded it
// (any row has a value). Inserted after Allocation only in that case, mirroring
// the old conditional column.
const COST_RATE_COLUMN: ColumnDef<StaffRow> = {
  id: "costRate",
  header: "Cost rate",
  accessorFn: (r) => r.costRate ?? -1,
  sortingFn: (a, b) => (a.original.costRate ?? -1) - (b.original.costRate ?? -1),
  cell: ({ row }) =>
    row.original.costRate != null ? (
      <span className="tabular-nums text-[var(--text-muted)]">
        ${row.original.costRate.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/hr
      </span>
    ) : (
      <span className="text-[var(--text-muted)]">—</span>
    ),
};

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

  // Cost rate is only present for finance-cleared callers; show its column only
  // when the loaded rows actually carry a value.
  const showCostRate = useMemo(() => staff.some((r) => r.costRate != null), [staff]);
  const columns = useMemo<ColumnDef<StaffRow>[]>(() => {
    if (!showCostRate) return STAFFING_COLUMNS;
    const i = STAFFING_COLUMNS.findIndex((c) => c.id === "allocation");
    const next = [...STAFFING_COLUMNS];
    next.splice(i + 1, 0, COST_RATE_COLUMN);
    return next;
  }, [showCostRate]);

  const patch = useCallback(
    (id: string, body: Record<string, unknown>) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    [apiBase],
  );

  // Right-click / ⋯ row menu. Membership is created/removed on the Members page
  // and there's no staffing DELETE route, so the menu is view + PATCH-only quick
  // edits (project role, on-contract) — no create/delete.
  const rowActions = useCallback(
    (row: StaffRow): ActionMenuGroup[] => {
      const groups: ActionMenuGroup[] = [
        { items: [{ label: "View details", icon: Eye, onClick: () => setOpenMemberId(row.id) }] },
      ];
      if (canEdit) {
        groups.push({
          label: "Set role",
          items: ROLE_OPTIONS.map((o) => ({
            label: o.label,
            icon: UserCog,
            onClick: async () => {
              try {
                await patch(row.id, { role: o.value });
                void refetch();
              } catch (e) {
                notifyError(e, "Couldn't update role.");
              }
            },
          })),
        });
        groups.push({
          items: [
            {
              label: row.onContract ? "Mark off contract" : "Mark on contract",
              icon: BadgeCheck,
              onClick: async () => {
                try {
                  await patch(row.id, { onContract: !row.onContract });
                  void refetch();
                } catch (e) {
                  notifyError(e, "Couldn't update contract status.");
                }
              },
            },
          ],
        });
      }
      return groups;
    },
    [canEdit, patch, refetch],
  );

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
    <>
      {/* Compliance summary header — kept above the shared table shell. */}
      {staff.length > 0 && (
        <div className="mx-auto max-w-6xl px-6 pt-6">
          <ComplianceSummary staff={staff} />
        </div>
      )}

      <PmDataTable
        title="Team & Staffing"
        subtitle={`${staff.length} team member${staff.length === 1 ? "" : "s"}`}
        rows={staff}
        columns={columns}
        search={filter}
        onSearchChange={setFilter}
        searchText={(r) => [r.name, r.laborCategory ?? "", r.clearance ?? ""].join(" ")}
        searchPlaceholder="Filter by name, labor category, or clearance…"
        onRowClick={(r) => setOpenMemberId(r.id)}
        rowActions={rowActions}
        renderBulkActions={
          canEdit
            ? (ids, clear) => (
                <>
                  <Select
                    onValueChange={async (v) => {
                      if (!v) return;
                      await bulkFanOut(ids, (id) => patch(id, { role: v }));
                      void refetch();
                      clear();
                    }}
                  >
                    <SelectTrigger className="h-8 w-36">
                      <SelectValue placeholder="Set role…" />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    onValueChange={async (v) => {
                      if (!v) return;
                      await bulkFanOut(ids, (id) => patch(id, { onContract: v === "true" }));
                      void refetch();
                      clear();
                    }}
                  >
                    <SelectTrigger className="h-8 w-40">
                      <SelectValue placeholder="On contract…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">On contract</SelectItem>
                      <SelectItem value="false">Off contract</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              )
            : undefined
        }
        emptyIcon={Users}
        emptyTitle="No team members yet"
        emptyDescription="Add people to this project on the Members tab."
      />

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
    </>
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
