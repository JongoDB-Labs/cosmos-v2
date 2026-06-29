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
}

const ROLE_OPTIONS: { value: ProjectRole; label: string }[] = [
  { value: "MANAGER", label: "Manager" },
  { value: "LEAD", label: "Lead" },
  { value: "MEMBER", label: "Member" },
  { value: "VIEWER", label: "Viewer" },
];

interface EditForm {
  role: ProjectRole;
  allocationPercent: string; // keep as string for the input, parse on submit
}

function rowToForm(row: StaffRow): EditForm {
  return {
    role: row.role,
    allocationPercent: row.allocationPercent != null ? String(row.allocationPercent) : "",
  };
}

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
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [form, setForm] = useState<EditForm>({ role: "MEMBER", allocationPercent: "" });

  const patchMutation = useOrgMutation<StaffRow, Error, { memberId: string; body: { role: ProjectRole; allocationPercent: number | null } }>({
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
    const parsed = form.allocationPercent.trim() === "" ? null : Number(form.allocationPercent);
    patchMutation.mutate({
      memberId: editing.id,
      body: {
        role: form.role,
        allocationPercent: parsed != null && !isNaN(parsed) ? parsed : null,
      },
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
              Update role and allocation for this team member.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
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
