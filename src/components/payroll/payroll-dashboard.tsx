"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ColumnDef } from "@tanstack/react-table";
import { PayRunDialog } from "./pay-run-dialog";

const fmt = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );

type Member = { userId: string; user: { displayName: string | null } };
type Employee = {
  id: string;
  userId: string;
  employmentType: "SALARY" | "HOURLY";
  costRate: string;
  laborCategory: string | null;
  status: string;
};
type PayRun = {
  id: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  status: "DRAFT" | "POSTED";
  laborCost: string;
};
type LaborGroup = { projectId: string | null; projectName: string | null; cost: string };

export function PayrollDashboard({ orgId }: { orgId: string }) {
  const [addOpen, setAddOpen] = useState(false);
  const [openRun, setOpenRun] = useState<PayRun | null>(null);

  const membersQ = useQuery({
    queryKey: useOrgQueryKey("members"),
    queryFn: () => jsonFetch<Member[]>(`/api/v1/orgs/${orgId}/members`),
  });
  const employeesQ = useQuery({
    queryKey: useOrgQueryKey("employees"),
    queryFn: () =>
      jsonFetch<{ data: Employee[] }>(`/api/v1/orgs/${orgId}/employees`).then((r) => r.data),
  });
  const payRunsQ = useQuery({
    queryKey: useOrgQueryKey("pay-runs"),
    queryFn: () =>
      jsonFetch<{ data: PayRun[] }>(`/api/v1/orgs/${orgId}/pay-runs`).then((r) => r.data),
  });
  const laborQ = useQuery({
    queryKey: useOrgQueryKey("payroll", "labor-by-project"),
    queryFn: () =>
      jsonFetch<{ data: LaborGroup[] }>(
        `/api/v1/orgs/${orgId}/payroll/labor-by-project`,
      ).then((r) => r.data),
  });

  const nameFor = (userId: string) =>
    (membersQ.data ?? []).find((m) => m.userId === userId)?.user.displayName ?? "Member";

  const employees = employeesQ.data ?? [];
  const employeeUserIds = new Set(employees.map((e) => e.userId));
  const availableMembers = (membersQ.data ?? []).filter((m) => !employeeUserIds.has(m.userId));

  const employeeCols: ColumnDef<Employee>[] = [
    { id: "name", header: "Name", cell: ({ row }) => nameFor(row.original.userId) },
    {
      accessorKey: "employmentType",
      header: "Type",
      cell: ({ row }) => <span className="text-xs">{row.original.employmentType}</span>,
    },
    {
      accessorKey: "costRate",
      header: "Cost rate / hr",
      cell: ({ row }) => <span className="tabular-nums">{fmt(row.original.costRate)}</span>,
    },
    { accessorKey: "laborCategory", header: "Category", cell: ({ row }) => row.original.laborCategory ?? "—" },
  ];

  const payRunCols: ColumnDef<PayRun>[] = [
    {
      id: "period",
      header: "Period",
      cell: ({ row }) =>
        `${new Date(row.original.periodStart).toLocaleDateString()} – ${new Date(
          row.original.periodEnd,
        ).toLocaleDateString()}`,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={row.original.status === "POSTED" ? "done" : "neutral"}>
          {row.original.status}
        </Badge>
      ),
    },
    {
      accessorKey: "laborCost",
      header: "Labor cost",
      cell: ({ row }) =>
        row.original.status === "POSTED" ? (
          <span className="tabular-nums">{fmt(row.original.laborCost)}</span>
        ) : (
          "—"
        ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button size="sm" variant="ghost" onClick={() => setOpenRun(row.original)}>
          {row.original.status === "POSTED" ? "View" : "Preview & post"}
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-8 p-6">
      {/* Labor by project */}
      {(laborQ.data ?? []).length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Posted labor by project</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(laborQ.data ?? []).map((g) => (
              <div key={g.projectId ?? "none"} className="rounded-md border bg-background p-3">
                <div className="truncate text-xs text-muted-foreground">
                  {g.projectId
                    ? (g.projectName ?? "Unknown project")
                    : "Unassigned"}
                </div>
                <div className="tabular-nums">{fmt(g.cost)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Employees */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Employees</h3>
          <Button size="sm" disabled={availableMembers.length === 0} onClick={() => setAddOpen(true)}>
            Add employee
          </Button>
        </div>
        {employeesQ.isLoading ? (
          <Skeleton className="h-32 rounded-lg" />
        ) : (
          <DataTable
            columns={employeeCols}
            data={employees}
            emptyState={<EmptyState title="No employees yet — add one to set a cost rate." />}
          />
        )}
      </section>

      {/* Pay runs */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Pay runs</h3>
        </div>
        <NewPayRunForm orgId={orgId} />
        {payRunsQ.isLoading ? (
          <Skeleton className="h-32 rounded-lg" />
        ) : (
          <DataTable
            columns={payRunCols}
            data={payRunsQ.data ?? []}
            emptyState={<EmptyState title="No pay runs yet — create a period above." />}
          />
        )}
      </section>

      <AddEmployeeDialog
        orgId={orgId}
        open={addOpen}
        onOpenChange={setAddOpen}
        members={availableMembers}
      />
      <PayRunDialog
        orgId={orgId}
        run={openRun}
        onOpenChange={(open) => {
          if (!open) setOpenRun(null);
        }}
      />
    </div>
  );
}

function NewPayRunForm({ orgId }: { orgId: string }) {
  const [label, setLabel] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const create = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/pay-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() || undefined, periodStart: start, periodEnd: end }),
      }),
    invalidate: [["pay-runs"]],
    onSuccess: () => {
      setLabel("");
      setStart("");
      setEnd("");
    },
    onError: (e) => notifyError(e, "Couldn't create the pay run."),
  });

  const valid = start !== "" && end !== "" && end >= start;

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
      <div className="flex flex-col gap-1">
        <Label className="text-xs" htmlFor="pay-run-start">Period start</Label>
        <Input id="pay-run-start" className="h-8" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs" htmlFor="pay-run-end">Period end</Label>
        <Input id="pay-run-end" className="h-8" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <Label className="text-xs" htmlFor="pay-run-label">Label (optional)</Label>
        <Input id="pay-run-label" className="h-8" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="June 1–15" />
      </div>
      <Button size="sm" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
        Create pay run
      </Button>
    </div>
  );
}

function AddEmployeeDialog({
  orgId,
  open,
  onOpenChange,
  members,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: Member[];
}) {
  const [userId, setUserId] = useState("");
  const [employmentType, setEmploymentType] = useState<"HOURLY" | "SALARY">("HOURLY");
  const [costRate, setCostRate] = useState("");
  const [laborCategory, setLaborCategory] = useState("");

  const create = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/employees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          employmentType,
          costRate: costRate || "0",
          laborCategory: laborCategory.trim() || null,
        }),
      }),
    invalidate: [["employees"]],
    onSuccess: () => {
      setUserId("");
      setCostRate("");
      setLaborCategory("");
      onOpenChange(false);
    },
    onError: (e) => notifyError(e, "Couldn't add the employee."),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add employee</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs" htmlFor="add-employee-member">Member</Label>
            <select
              id="add-employee-member"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">— select —</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user.displayName ?? "Member"}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-xs" htmlFor="add-employee-type">Type</Label>
              <select
                id="add-employee-type"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={employmentType}
                onChange={(e) => setEmploymentType(e.target.value as "HOURLY" | "SALARY")}
              >
                <option value="HOURLY">Hourly</option>
                <option value="SALARY">Salary</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs" htmlFor="add-employee-cost-rate">Cost rate / hr</Label>
              <Input
                id="add-employee-cost-rate"
                className="h-9"
                type="number"
                step="0.01"
                min="0"
                value={costRate}
                onChange={(e) => setCostRate(e.target.value)}
                placeholder="65.00"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs" htmlFor="add-employee-labor-category">Labor category (optional)</Label>
            <Input
              id="add-employee-labor-category"
              className="h-9"
              value={laborCategory}
              onChange={(e) => setLaborCategory(e.target.value)}
              placeholder="Senior Engineer"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={userId === "" || Number(costRate) < 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
