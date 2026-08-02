"use client";
import { useCallback, useState } from "react";
import { Eye } from "lucide-react";
import { toast } from "sonner";
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
  DialogFooter,
} from "@/components/ui/dialog";
import type { ColumnDef } from "@tanstack/react-table";
import type { ActionMenuGroup } from "@/components/ui/action-menu";
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
  /** Supervisor, as another Employee's id. */
  managerId: string | null;
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
    // jsonFetch already unwraps the single-key { data } envelope.
    queryFn: () =>
      jsonFetch<LaborGroup[]>(`/api/v1/orgs/${orgId}/payroll/labor-by-project`),
  });

  const nameFor = (userId: string) =>
    (membersQ.data ?? []).find((m) => m.userId === userId)?.user.displayName ?? "Member";

  // Surface the pay-run row's existing operation (open the PayRunDialog) as a
  // right-click / ⋯ menu item. Reuses setOpenRun — no new endpoints.
  const payRunActions = useCallback(
    (run: PayRun): ActionMenuGroup[] => [
      {
        items: [
          {
            label: run.status === "POSTED" ? "View" : "Preview & post",
            icon: Eye,
            onClick: () => setOpenRun(run),
          },
        ],
      },
    ],
    [],
  );

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
    {
      id: "supervisor",
      header: "Supervisor",
      cell: ({ row }) => (
        <SupervisorCell
          orgId={orgId}
          employee={row.original}
          nameFor={nameFor}
        />
      ),
    },
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
        {!employeesQ.isLoading && !membersQ.isLoading && availableMembers.length > 0 && (
          <BulkAddEmployeesPrompt orgId={orgId} members={availableMembers} />
        )}
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
        {/* Stated in the open rather than behind a hover tooltip. "Pay run" is
            jargon — somebody who does not already know what one is has no
            reason to hover over the words to find out, and a hover hint is
            invisible on touch and to keyboard users. Same always-visible
            description pattern PageShell uses on every screen. */}
        <p className="-mt-2 text-xs text-muted-foreground">
          A pay run closes a pay period: it prices every approved timesheet in
          the date range at each person&apos;s cost rate and posts the total to
          the ledger, split across the projects the hours were worked on.
          Preview it first — posting is what turns those figures into real
          accounting entries.
        </p>
        <NewPayRunForm orgId={orgId} />
        {payRunsQ.isLoading ? (
          <Skeleton className="h-32 rounded-lg" />
        ) : (
          <DataTable
            columns={payRunCols}
            data={payRunsQ.data ?? []}
            rowActions={payRunActions}
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

/**
 * "These people have no employee record" — and one click to fix it.
 *
 * Everything about supervision, timesheet approval and labor costing hangs off
 * an `Employee` row. An org that has never used payroll has none, so nobody can
 * be given a supervisor and the approval chain never starts; the only cure was
 * "Add employee", one person at a time, each demanding a cost rate before it
 * would save. That is why production orgs sat at 26 members and zero employees.
 *
 * Everyone is pre-selected because onboarding the whole org is the normal case
 * and the exceptions are few — but they are individually deselectable, because
 * contractors and non-billable members exist and adding them is not free to
 * undo.
 *
 * The zero cost rate is stated on the button's own line rather than buried: the
 * server will not invent a rate (a plausible-looking wrong one corrupts labor
 * expense and CLIN burn silently), so the person clicking has to know the rates
 * arrive unset and are theirs to fill in.
 */
function BulkAddEmployeesPrompt({
  orgId,
  members,
}: {
  orgId: string;
  members: Member[];
}) {
  const [expanded, setExpanded] = useState(false);
  // Tracks EXCLUSIONS rather than selections so the default is "everyone", and
  // so a stale id left behind after a successful add is harmless — the list it
  // filters has already lost that person.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const chosen = members.filter((m) => !excluded.has(m.userId));

  const add = useOrgMutation<
    { created: number; skipped: number },
    Error,
    void
  >({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/employees/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: chosen.map((m) => m.userId) }),
      }),
    invalidate: [["employees"]],
    onSuccess: (res) => {
      setExpanded(false);
      // An untick means "not in THIS batch", not "never". Once the batch is
      // committed the prompt is a fresh question about whoever is left, and
      // carrying the exclusions over strands it on a DISABLED "Add 0 employee
      // records" whose only explanation is hidden behind "Choose who" — the
      // exact dead end that appeared when this was driven on a real screen.
      setExcluded(new Set());
      toast.success(
        res.created === 1
          ? "1 employee record added. Set its cost rate before running payroll."
          : `${res.created} employee records added. Set their cost rates before running payroll.`,
      );
    },
    onError: (e) => notifyError(e, "Couldn't add the employee records."),
  });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/30 p-4">
      <div>
        <h4 className="text-sm font-semibold">
          {members.length === 1
            ? "1 member has no employee record"
            : `${members.length} members have no employee record`}
        </h4>
        <p className="mt-1 text-sm text-muted-foreground">
          Until someone has an employee record they cannot be given a
          supervisor, so their timesheets have nobody to go to and their hours
          cost nothing. Adding them here creates each record with a{" "}
          <strong className="font-medium text-foreground">
            cost rate of $0.00
          </strong>{" "}
          — no rate is guessed. Set the real rates in the table below before you
          run payroll, or that time will be costed at zero.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={chosen.length === 0 || add.isPending}
          onClick={() => add.mutate()}
        >
          {chosen.length === 1
            ? "Add 1 employee record"
            : `Add ${chosen.length} employee records`}
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide list" : "Choose who"}
        </Button>
        {chosen.length < members.length && (
          <span className="text-xs text-muted-foreground">
            {members.length - chosen.length} skipped
          </span>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setExcluded(new Set())}
            >
              Select all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setExcluded(new Set(members.map((m) => m.userId)))}
            >
              Select none
            </Button>
          </div>
          <ul className="max-h-64 overflow-y-auto rounded-md border bg-background p-2">
            {members.map((m) => (
              <li key={m.userId}>
                <label className="flex items-center gap-2 px-1 py-1 text-sm">
                  <input
                    type="checkbox"
                    checked={!excluded.has(m.userId)}
                    disabled={add.isPending}
                    onChange={(e) =>
                      setExcluded((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.delete(m.userId);
                        else next.add(m.userId);
                        return next;
                      })
                    }
                  />
                  {m.user.displayName ?? "Member"}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The supervisors picker, editable in place.
 *
 * SEVERAL are allowed — a matrixed org, a deputy covering leave, someone split
 * across two programmes — so this is a checklist rather than a dropdown. Every
 * supervisor is notified when a week is submitted, which is the point: a single
 * named approver on holiday is exactly how a timesheet stalls.
 *
 * Deliberately inline rather than in the Add dialog: supervisors change when
 * people move teams, so setting them only at creation would make the org chart
 * unmaintainable — you would have to delete and recreate the employee, taking
 * their cost rate (and any pay run referencing it) with them.
 *
 * Candidates come from the SERVER, not from the rows on screen, because the
 * rule is no longer purely structural: a candidate must also hold TIME_APPROVE.
 * The client cannot evaluate that — permission masks never leave the server.
 */
function SupervisorCell({
  orgId,
  employee,
  nameFor,
}: {
  orgId: string;
  employee: Employee;
  nameFor: (userId: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const queryKey = useOrgQueryKey("employee-supervisors", employee.id);
  const { data } = useQuery<{
    supervisorIds: string[];
    candidates: Array<{
      employeeId: string;
      userId: string;
      displayName: string | null;
      /** False for someone assigned before they lost the approve-time permission. */
      canApprove: boolean;
    }>;
    /** Can approve time, but has no employee record — so cannot be offered. */
    approversMissingEmployeeRecord: string[];
  }>({
    queryKey,
    queryFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/employees/${employee.id}/supervisors`),
    // Only fetched once the row is actually being edited: one request per
    // employee on every payroll load would be N requests for a control most
    // visits never touch.
    enabled: open,
  });

  const update = useOrgMutation<unknown, Error, string[]>({
    mutationFn: (supervisorIds) =>
      jsonFetch(`/api/v1/orgs/${orgId}/employees/${employee.id}/supervisors`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supervisorIds }),
      }),
    invalidate: [["employees"], ["employee-supervisors", employee.id]],
    onError: (e) => notifyError(e, "Couldn't change the supervisors."),
  });

  const selected = data?.supervisorIds ?? [];
  const label =
    selected.length === 0
      ? "— none —"
      : selected.length === 1
        ? nameFor(
            data?.candidates.find((c) => c.employeeId === selected[0])?.userId ?? "",
          ) || "1 supervisor"
        : `${selected.length} supervisors`;

  function toggle(employeeId: string, on: boolean) {
    const next = on
      ? [...selected, employeeId]
      : selected.filter((id) => id !== employeeId);
    update.mutate(next);
  }

  return (
    <>
      <button
        type="button"
        // Every row renders one of these, so the accessible name has to carry
        // WHOSE supervisors these are — "Supervisors" alone repeats N times.
        aria-label={`Supervisors for ${nameFor(employee.userId)}`}
        className="h-8 rounded-md border bg-background px-2 text-xs"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>

      {/* A DIALOG, not an inline dropdown. The previous version was an
          absolutely-positioned panel inside the employees table, which sits in
          an overflow container — so it was clipped and pushed below the table
          instead of floating over it. A dialog portals to the body and cannot
          be trapped by an ancestor's overflow, and it gives long names room. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Supervisors for {nameFor(employee.userId)}
            </DialogTitle>
          </DialogHeader>

          <p className="text-sm text-muted-foreground">
            Everyone selected is notified when this person submits a week, and
            any one of them can approve it. Only people who can approve time are
            listed.
          </p>

          <div className="flex flex-col gap-1">
            {data === undefined ? (
              <p className="px-1 py-0.5 text-sm text-muted-foreground">Loading…</p>
            ) : data.candidates.length === 0 ? (
              // Two DIFFERENT causes, and telling them apart is the whole
              // point. Saying "nobody can approve time" to an admin who has
              // just granted the Reviewer / Approver role sends them to redo
              // the step they already did — the actual blocker is that the
              // person they granted it to is not an employee.
              data.approversMissingEmployeeRecord.length > 0 ? (
                <p className="px-1 py-0.5 text-sm text-muted-foreground">
                  {data.approversMissingEmployeeRecord.join(", ")}{" "}
                  {data.approversMissingEmployeeRecord.length === 1
                    ? "can approve time but has"
                    : "can approve time but have"}{" "}
                  no employee record, so they cannot be a supervisor yet. Add
                  them under Employees above and they will appear here.
                </p>
              ) : (
                <p className="px-1 py-0.5 text-sm text-muted-foreground">
                  Nobody in this organisation can approve time yet. Grant
                  someone the Reviewer / Approver role first.
                </p>
              )
            ) : (
              data.candidates.map((c) => (
                <label
                  key={c.employeeId}
                  className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(c.employeeId)}
                    disabled={update.isPending}
                    onChange={(e) => toggle(c.employeeId, e.target.checked)}
                  />
                  {c.displayName ?? nameFor(c.userId)}
                  {!c.canApprove && (
                    // Assigned before they lost the permission. Shown so the
                    // assignment stays visible and removable, but marked — they
                    // are here by history rather than by policy.
                    <span className="text-xs text-muted-foreground">
                      (no approve permission)
                    </span>
                  )}
                </label>
              ))
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
