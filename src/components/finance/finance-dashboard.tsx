"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey, useOrgSlug, orgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import type { ColumnDef } from "@tanstack/react-table";
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
  DollarSign,
  TrendingUp,
  TrendingDown,
  Clock,
  Plus,
  Trash2,
  Pencil,
  Copy,
  Send,
  Check,
  X,
} from "lucide-react";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "@/components/charts/lazy-recharts";
import type { PieLabelRenderProps } from "@/components/charts/lazy-recharts";
import type { Revenue, Expense } from "@/types/models";

interface FinanceDashboardProps {
  orgId: string;
  userId: string;
}

const EXPENSE_STATUS_VARIANT: Record<
  string,
  "neutral" | "progress" | "done" | "critical"
> = {
  DRAFT: "neutral",
  SUBMITTED: "progress",
  APPROVED: "done",
  REJECTED: "critical",
};

const EXPENSE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

// NOTE: the /finance/summary endpoint returns these money values as bare JS numbers
// (it converts its Decimal aggregates via moneyToNumber for the charts) — UNLIKE the
// list endpoints, where raw entity money (Revenue.amount etc.) arrives as a string.
interface FinanceSummary {
  totalRevenue: number;
  totalExpenses: number;
  netIncome: number;
  billableHours: number;
  monthlyTrend: { month: string; revenue: number; expenses: number }[];
  revenueByType: { type: string; amount: number }[];
  expensesByCategory: { category: string; amount: number }[];
}

function formatCurrency(amount: number | string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(amount));
}

const PIE_COLORS = [
  "var(--status-progress)",
  "var(--status-discovery)",
  "var(--status-warning)",
  "var(--status-success)",
  "var(--status-critical)",
  "var(--status-info)",
];

type FinanceTab = "revenue" | "expenses";

interface RevenueFormData {
  amount: string;
  currency: string;
  date: string;
  client: string;
  product: string;
  type: Revenue["type"];
  description: string;
}

interface ExpenseFormData {
  amount: string;
  currency: string;
  date: string;
  category: string;
  vendor: string;
  description: string;
  recurring: boolean;
}

const emptyRevenueForm: RevenueFormData = {
  amount: "",
  currency: "USD",
  date: new Date().toISOString().split("T")[0],
  client: "",
  product: "",
  type: "ONE_TIME",
  description: "",
};

const emptyExpenseForm: ExpenseFormData = {
  amount: "",
  currency: "USD",
  date: new Date().toISOString().split("T")[0],
  category: "",
  vendor: "",
  description: "",
  recurring: false,
};

export function FinanceDashboard({ orgId, userId }: FinanceDashboardProps) {
  const orgSlug = useOrgSlug();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const [tab, setTab] = useState<FinanceTab>("revenue");
  const [revenueDialogOpen, setRevenueDialogOpen] = useState(false);
  const [expenseDialogOpen, setExpenseDialogOpen] = useState(false);
  const [revenueForm, setRevenueForm] = useState<RevenueFormData>(emptyRevenueForm);
  const [expenseForm, setExpenseForm] = useState<ExpenseFormData>(emptyExpenseForm);
  // When set, the dialog edits the existing row (PUT). When null, it creates
  // a new row (POST) — used for both "Add" and "Duplicate".
  const [editingRevenue, setEditingRevenue] = useState<string | null>(null);
  const [editingExpense, setEditingExpense] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const qs = (() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("startDate", dateFrom);
    if (dateTo) params.set("endDate", dateTo);
    return params.toString() ? `?${params}` : "";
  })();

  const summaryKey = useOrgQueryKey("finance", "summary", { dateFrom, dateTo });
  const revenueKey = useOrgQueryKey("finance", "revenue", { dateFrom, dateTo });
  const expensesKey = useOrgQueryKey("finance", "expenses", { dateFrom, dateTo });

  const summaryQ = useQuery({
    queryKey: summaryKey,
    queryFn: () =>
      jsonFetch<FinanceSummary>(`/api/v1/orgs/${orgId}/finance/summary${qs}`),
  });

  const revenueQ = useQuery({
    queryKey: revenueKey,
    queryFn: async () => {
      // The list GET returns `{ data, total }`; jsonFetch only auto-unwraps a
      // single-key `{ data }` envelope, so read `.data` explicitly here.
      const data = await jsonFetch<
        Revenue[] | { data?: Revenue[]; revenues?: Revenue[] }
      >(`/api/v1/orgs/${orgId}/finance/revenue${qs}`);
      return Array.isArray(data) ? data : (data.data ?? data.revenues ?? []);
    },
  });

  const expensesQ = useQuery({
    queryKey: expensesKey,
    queryFn: async () => {
      // The list GET returns `{ data, total }`; jsonFetch only auto-unwraps a
      // single-key `{ data }` envelope, so read `.data` explicitly here.
      const data = await jsonFetch<
        Expense[] | { data?: Expense[]; expenses?: Expense[] }
      >(`/api/v1/orgs/${orgId}/finance/expenses${qs}`);
      return Array.isArray(data) ? data : (data.data ?? data.expenses ?? []);
    },
  });

  const summary = summaryQ.data ?? null;
  const revenues = revenueQ.data ?? [];
  const expenses = expensesQ.data ?? [];
  const loading = summaryQ.isLoading || revenueQ.isLoading || expensesQ.isLoading;

  function invalidateFinance() {
    qc.invalidateQueries({ queryKey: orgQueryKey(orgSlug, "finance") });
  }

  const createRevenueMutation = useOrgMutation<
    Revenue,
    Error,
    Record<string, unknown>
  >({
    mutationFn: (body) =>
      jsonFetch(`/api/v1/orgs/${orgId}/finance/revenue`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setRevenueDialogOpen(false);
      setRevenueForm(emptyRevenueForm);
      setEditingRevenue(null);
      invalidateFinance();
    },
    onError: (err) => notifyError(err, "Couldn't add the revenue entry."),
  });

  const createExpenseMutation = useOrgMutation<
    Expense,
    Error,
    Record<string, unknown>
  >({
    mutationFn: (body) =>
      jsonFetch(`/api/v1/orgs/${orgId}/finance/expenses`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setExpenseDialogOpen(false);
      setExpenseForm(emptyExpenseForm);
      setEditingExpense(null);
      invalidateFinance();
    },
    onError: (err) => notifyError(err, "Couldn't add the expense entry."),
  });

  const updateRevenueMutation = useOrgMutation<
    Revenue,
    Error,
    { id: string; body: Record<string, unknown> }
  >({
    mutationFn: ({ id, body }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/finance/revenue/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setRevenueDialogOpen(false);
      setRevenueForm(emptyRevenueForm);
      setEditingRevenue(null);
      invalidateFinance();
    },
    onError: (err) => notifyError(err, "Couldn't update the revenue entry."),
  });

  const updateExpenseMutation = useOrgMutation<
    Expense,
    Error,
    { id: string; body: Record<string, unknown> }
  >({
    mutationFn: ({ id, body }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/finance/expenses/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setExpenseDialogOpen(false);
      setExpenseForm(emptyExpenseForm);
      setEditingExpense(null);
      invalidateFinance();
    },
    onError: (err) => notifyError(err, "Couldn't update the expense entry."),
  });

  const deleteRevenueMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/finance/revenue/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => invalidateFinance(),
    onError: (err) => notifyError(err, "Couldn't delete the revenue entry."),
  });

  const deleteExpenseMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/finance/expenses/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => invalidateFinance(),
    onError: (err) => notifyError(err, "Couldn't delete the expense entry."),
  });

  const submitExpenseMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/finance/expenses/${id}/submit`, {
        method: "POST",
      }),
    onSuccess: () => invalidateFinance(),
    onError: (err) => notifyError(err, "Couldn't submit the expense for approval."),
  });

  const decideExpenseMutation = useOrgMutation<
    unknown,
    Error,
    { id: string; action: "approve" | "reject" }
  >({
    mutationFn: ({ id, action }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/finance/expenses/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    onSuccess: () => invalidateFinance(),
    onError: (err) => notifyError(err, "Couldn't update the expense approval."),
  });

  const saving =
    createRevenueMutation.isPending ||
    createExpenseMutation.isPending ||
    updateRevenueMutation.isPending ||
    updateExpenseMutation.isPending ||
    deleteRevenueMutation.isPending ||
    deleteExpenseMutation.isPending;

  const handleSubmitRevenue = () => {
    const body = {
      amount: parseFloat(revenueForm.amount) || 0,
      currency: revenueForm.currency,
      date: revenueForm.date,
      client: revenueForm.client || null,
      product: revenueForm.product || null,
      type: revenueForm.type,
      description: revenueForm.description,
    };
    if (editingRevenue) {
      updateRevenueMutation.mutate({ id: editingRevenue, body });
    } else {
      createRevenueMutation.mutate(body);
    }
  };

  const handleSubmitExpense = () => {
    const body = {
      amount: parseFloat(expenseForm.amount) || 0,
      currency: expenseForm.currency,
      date: expenseForm.date,
      category: expenseForm.category,
      vendor: expenseForm.vendor || null,
      description: expenseForm.description,
      recurring: expenseForm.recurring,
    };
    if (editingExpense) {
      updateExpenseMutation.mutate({ id: editingExpense, body });
    } else {
      createExpenseMutation.mutate(body);
    }
  };

  // Edit opens the dialog pre-filled and bound to the row id (PUT on save).
  const handleEditRevenue = (rev: Revenue) => {
    setEditingRevenue(rev.id);
    setRevenueForm({
      amount: String(rev.amount),
      currency: rev.currency,
      date: new Date(rev.date).toISOString().split("T")[0],
      client: rev.client ?? "",
      product: rev.product ?? "",
      type: rev.type,
      description: rev.description,
    });
    setRevenueDialogOpen(true);
  };

  // Duplicate pre-fills the form WITHOUT a row id, so saving creates a new row.
  const handleDuplicateRevenue = (rev: Revenue) => {
    setEditingRevenue(null);
    setRevenueForm({
      amount: String(rev.amount),
      currency: rev.currency,
      date: new Date(rev.date).toISOString().split("T")[0],
      client: rev.client ?? "",
      product: rev.product ?? "",
      type: rev.type,
      description: rev.description,
    });
    setRevenueDialogOpen(true);
  };

  const handleEditExpense = (exp: Expense) => {
    setEditingExpense(exp.id);
    setExpenseForm({
      amount: String(exp.amount),
      currency: exp.currency,
      date: new Date(exp.date).toISOString().split("T")[0],
      category: exp.category,
      vendor: exp.vendor ?? "",
      description: exp.description,
      recurring: exp.recurring,
    });
    setExpenseDialogOpen(true);
  };

  const handleDuplicateExpense = (exp: Expense) => {
    setEditingExpense(null);
    setExpenseForm({
      amount: String(exp.amount),
      currency: exp.currency,
      date: new Date(exp.date).toISOString().split("T")[0],
      category: exp.category,
      vendor: exp.vendor ?? "",
      description: exp.description,
      recurring: exp.recurring,
    });
    setExpenseDialogOpen(true);
  };

  // Reset edit state + clear the form whenever a dialog closes so the next
  // "Add" starts blank and isn't accidentally bound to a stale row id.
  const handleRevenueDialogChange = (open: boolean) => {
    setRevenueDialogOpen(open);
    if (!open) {
      setEditingRevenue(null);
      setRevenueForm(emptyRevenueForm);
    }
  };

  const handleExpenseDialogChange = (open: boolean) => {
    setExpenseDialogOpen(open);
    if (!open) {
      setEditingExpense(null);
      setExpenseForm(emptyExpenseForm);
    }
  };

  const handleDeleteRevenue = (id: string) => {
    deleteRevenueMutation.mutate(id);
  };

  const handleDeleteExpense = (id: string) => {
    deleteExpenseMutation.mutate(id);
  };

  if (summaryQ.isError || revenueQ.isError || expensesQ.isError) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <LoadError
          onRetry={() => {
            summaryQ.refetch();
            revenueQ.refetch();
            expensesQ.refetch();
          }}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-6 p-6">
        {/* Minimal skeleton: mirror the content's first row (right-aligned
            From/To filter) so real content grows DOWNWARD instead of the tall
            skeleton collapsing upward (CLS). Title is owned by PageShell. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-9 w-40 rounded-lg" />
            <span className="text-sm text-muted-foreground">to</span>
            <Skeleton className="h-9 w-40 rounded-lg" />
          </div>
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
        {/* Title/subtitle owned by the page shell (PageShell). */}
        <div className="flex flex-wrap items-center gap-2">
          <DatePicker
            value={dateFrom}
            onValueChange={setDateFrom}
            placeholder="From"
            aria-label="From date"
            className="w-40"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <DatePicker
            value={dateTo}
            onValueChange={setDateTo}
            placeholder="To"
            aria-label="To date"
            className="w-40"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Colour encodes the SIGN of the value: $0 is neutral, not a red/green
            alarm. Only a positive amount earns its income/expense colour. */}
        <SummaryCard
          title="Total Revenue"
          value={formatCurrency(summary?.totalRevenue || 0)}
          icon={
            <DollarSign
              className={cn(
                "size-5",
                (summary?.totalRevenue || 0) > 0 ? "text-green-500" : "text-muted-foreground",
              )}
            />
          }
          accent={(summary?.totalRevenue || 0) > 0 ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}
        />
        <SummaryCard
          title="Total Expenses"
          value={formatCurrency(summary?.totalExpenses || 0)}
          icon={
            <TrendingDown
              className={cn(
                "size-5",
                (summary?.totalExpenses || 0) > 0 ? "text-red-500" : "text-muted-foreground",
              )}
            />
          }
          accent={(summary?.totalExpenses || 0) > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}
        />
        <SummaryCard
          title="Net Income"
          value={formatCurrency(summary?.netIncome || 0)}
          icon={<TrendingUp className="size-5 text-blue-500" />}
          accent={
            (summary?.netIncome || 0) > 0
              ? "text-green-600 dark:text-green-400"
              : (summary?.netIncome || 0) < 0
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground"
          }
        />
        <SummaryCard
          title="Billable Hours"
          value={`${(summary?.billableHours || 0).toFixed(1)}h`}
          icon={<Clock className="size-5 text-purple-500" />}
          accent="text-purple-600 dark:text-purple-400"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border p-4">
          <h3 className="mb-4 text-sm font-semibold">Monthly Trend</h3>
          {summary?.monthlyTrend && summary.monthlyTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={summary.monthlyTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: "var(--color-muted-foreground)" }} stroke="var(--color-border)" />
                <YAxis tick={{ fontSize: 12, fill: "var(--color-muted-foreground)" }} stroke="var(--color-border)" />
                <Tooltip
                  formatter={(value) => formatCurrency(Number(value ?? 0))}
                  contentStyle={{
                    backgroundColor: "var(--color-popover)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Bar dataKey="revenue" fill="var(--status-progress)" radius={[4, 4, 0, 0]} name="Revenue" />
                <Bar dataKey="expenses" fill="var(--status-critical)" radius={[4, 4, 0, 0]} name="Expenses" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              No data available for the selected period
            </div>
          )}
        </div>

        <div className="rounded-lg border p-4">
          <h3 className="mb-4 text-sm font-semibold">Revenue by Type</h3>
          {summary?.revenueByType && summary.revenueByType.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={summary.revenueByType}
                  dataKey="amount"
                  nameKey="type"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={(props: PieLabelRenderProps) =>
                    `${String(props.name ?? "")} (${(((props.percent as number) ?? 0) * 100).toFixed(0)}%)`
                  }
                >
                  {summary.revenueByType.map((_, index) => (
                    <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatCurrency(Number(value ?? 0))} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              No revenue data available
            </div>
          )}
        </div>
      </div>

      {summary?.expensesByCategory && summary.expensesByCategory.length > 0 && (
        <div className="rounded-lg border p-4">
          <h3 className="mb-4 text-sm font-semibold">Expenses by Category</h3>
          <ResponsiveContainer width="100%" height={Math.max(200, summary.expensesByCategory.length * 40)}>
            <BarChart data={summary.expensesByCategory} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis type="number" tick={{ fontSize: 12, fill: "var(--color-muted-foreground)" }} stroke="var(--color-border)" />
              <YAxis dataKey="category" type="category" width={120} tick={{ fontSize: 12, fill: "var(--color-muted-foreground)" }} stroke="var(--color-border)" />
              <Tooltip
                formatter={(value) => formatCurrency(Number(value ?? 0))}
                contentStyle={{
                  backgroundColor: "var(--color-popover)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              />
              <Bar dataKey="amount" fill="var(--status-discovery)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border bg-muted/50 p-0.5">
            <button
              onClick={() => setTab("revenue")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === "revenue"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Revenue
            </button>
            <button
              onClick={() => setTab("expenses")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === "expenses"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Expenses
            </button>
          </div>
        </div>

        {tab === "revenue" ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Revenue Entries</h3>
              <Dialog open={revenueDialogOpen} onOpenChange={handleRevenueDialogChange}>
                <DialogTrigger
                  render={
                    <Button size="sm">
                      <Plus className="size-4" />
                      Add Revenue
                    </Button>
                  }
                />
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>
                      {editingRevenue ? "Edit Revenue" : "Add Revenue"}
                    </DialogTitle>
                  </DialogHeader>
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="rev-amount">Amount</Label>
                        <Input
                          id="rev-amount"
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          value={revenueForm.amount}
                          onChange={(e) =>
                            setRevenueForm({ ...revenueForm, amount: e.target.value })
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="rev-currency">Currency</Label>
                        <Input
                          id="rev-currency"
                          value={revenueForm.currency}
                          onChange={(e) =>
                            setRevenueForm({ ...revenueForm, currency: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Date</Label>
                      <DatePicker
                        value={revenueForm.date}
                        onValueChange={(date) =>
                          setRevenueForm({ ...revenueForm, date })
                        }
                        aria-label="Revenue date"
                        clearable={false}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="rev-client">Client</Label>
                        <Input
                          id="rev-client"
                          placeholder="Client name"
                          value={revenueForm.client}
                          onChange={(e) =>
                            setRevenueForm({ ...revenueForm, client: e.target.value })
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="rev-product">Product</Label>
                        <Input
                          id="rev-product"
                          placeholder="Product name"
                          value={revenueForm.product}
                          onChange={(e) =>
                            setRevenueForm({ ...revenueForm, product: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Type</Label>
                      <Select
                        value={revenueForm.type}
                        onValueChange={(val) =>
                          setRevenueForm({
                            ...revenueForm,
                            type: val as Revenue["type"],
                          })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="RECURRING">Recurring</SelectItem>
                          <SelectItem value="ONE_TIME">One-Time</SelectItem>
                          <SelectItem value="PROJECT_BASED">Project-Based</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="rev-desc">Description</Label>
                      <Textarea
                        id="rev-desc"
                        placeholder="Revenue description"
                        value={revenueForm.description}
                        onChange={(e) =>
                          setRevenueForm({ ...revenueForm, description: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => handleRevenueDialogChange(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleSubmitRevenue}
                      disabled={saving || !revenueForm.amount}
                    >
                      {saving ? "Saving..." : "Save"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
            <DataTable
              columns={
                [
                  {
                    accessorKey: "date",
                    header: "Date",
                    cell: ({ row }) => (
                      <span className="whitespace-nowrap">
                        {new Date(row.original.date).toLocaleDateString()}
                      </span>
                    ),
                  },
                  {
                    accessorKey: "description",
                    header: "Description",
                    cell: ({ row }) => (
                      <span className="block max-w-48 truncate">
                        {row.original.description}
                      </span>
                    ),
                  },
                  {
                    accessorKey: "client",
                    header: "Client",
                    cell: ({ row }) => row.original.client || "-",
                  },
                  {
                    accessorKey: "type",
                    header: "Type",
                    cell: ({ row }) => (
                      <Badge variant="neutral" className="text-xs">
                        {row.original.type.replace("_", " ")}
                      </Badge>
                    ),
                  },
                  {
                    accessorKey: "amount",
                    header: "Amount",
                    cell: ({ row }) => (
                      <span className="whitespace-nowrap font-medium md:text-right md:block">
                        {formatCurrency(row.original.amount)}
                      </span>
                    ),
                  },
                  {
                    id: "actions",
                    header: "",
                    enableSorting: false,
                    cell: ({ row }) => {
                      const groups: ActionMenuGroup[] = [
                        {
                          items: [
                            ...(can(Permission.FINANCE_MANAGE)
                              ? [
                                  {
                                    label: "Edit",
                                    icon: Pencil,
                                    onClick: () =>
                                      handleEditRevenue(row.original),
                                  },
                                  {
                                    label: "Duplicate",
                                    icon: Copy,
                                    onClick: () =>
                                      handleDuplicateRevenue(row.original),
                                  },
                                ]
                              : []),
                          ],
                        },
                        {
                          items: [
                            ...(can(Permission.FINANCE_MANAGE)
                              ? [
                                  {
                                    label: "Delete",
                                    icon: Trash2,
                                    variant: "destructive" as const,
                                    onClick: () =>
                                      handleDeleteRevenue(row.original.id),
                                  },
                                ]
                              : []),
                          ],
                        },
                      ];
                      return (
                        <div className="flex justify-end group/action">
                          <ActionMenu groups={groups}>
                            <span />
                          </ActionMenu>
                        </div>
                      );
                    },
                  },
                ] satisfies ColumnDef<Revenue>[]
              }
              data={revenues}
              emptyState={<EmptyState title="No revenue entries yet." />}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Expense Entries</h3>
              <Dialog open={expenseDialogOpen} onOpenChange={handleExpenseDialogChange}>
                <DialogTrigger
                  render={
                    <Button size="sm">
                      <Plus className="size-4" />
                      Add Expense
                    </Button>
                  }
                />
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>
                      {editingExpense ? "Edit Expense" : "Add Expense"}
                    </DialogTitle>
                  </DialogHeader>
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="exp-amount">Amount</Label>
                        <Input
                          id="exp-amount"
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          value={expenseForm.amount}
                          onChange={(e) =>
                            setExpenseForm({ ...expenseForm, amount: e.target.value })
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="exp-currency">Currency</Label>
                        <Input
                          id="exp-currency"
                          value={expenseForm.currency}
                          onChange={(e) =>
                            setExpenseForm({ ...expenseForm, currency: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Date</Label>
                      <DatePicker
                        value={expenseForm.date}
                        onValueChange={(date) =>
                          setExpenseForm({ ...expenseForm, date })
                        }
                        aria-label="Expense date"
                        clearable={false}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="exp-category">Category</Label>
                        <Input
                          id="exp-category"
                          placeholder="e.g., Software, Travel"
                          value={expenseForm.category}
                          onChange={(e) =>
                            setExpenseForm({ ...expenseForm, category: e.target.value })
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="exp-vendor">Vendor</Label>
                        <Input
                          id="exp-vendor"
                          placeholder="Vendor name"
                          value={expenseForm.vendor}
                          onChange={(e) =>
                            setExpenseForm({ ...expenseForm, vendor: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="exp-desc">Description</Label>
                      <Textarea
                        id="exp-desc"
                        placeholder="Expense description"
                        value={expenseForm.description}
                        onChange={(e) =>
                          setExpenseForm({ ...expenseForm, description: e.target.value })
                        }
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={expenseForm.recurring}
                        onChange={(e) =>
                          setExpenseForm({ ...expenseForm, recurring: e.target.checked })
                        }
                        className="size-4 rounded border-border"
                      />
                      Recurring expense
                    </label>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => handleExpenseDialogChange(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleSubmitExpense}
                      disabled={saving || !expenseForm.amount || !expenseForm.category}
                    >
                      {saving ? "Saving..." : "Save"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
            <DataTable
              columns={
                [
                  {
                    accessorKey: "date",
                    header: "Date",
                    cell: ({ row }) => (
                      <span className="whitespace-nowrap">
                        {new Date(row.original.date).toLocaleDateString()}
                      </span>
                    ),
                  },
                  {
                    accessorKey: "description",
                    header: "Description",
                    cell: ({ row }) => (
                      <span className="block max-w-48 truncate">
                        {row.original.description}
                      </span>
                    ),
                  },
                  {
                    accessorKey: "category",
                    header: "Category",
                    cell: ({ row }) => (
                      <Badge variant="neutral" className="text-xs">
                        {row.original.category}
                      </Badge>
                    ),
                  },
                  {
                    accessorKey: "vendor",
                    header: "Vendor",
                    cell: ({ row }) => row.original.vendor || "-",
                  },
                  {
                    accessorKey: "amount",
                    header: "Amount",
                    cell: ({ row }) => (
                      <span className="whitespace-nowrap font-medium md:text-right md:block">
                        {formatCurrency(row.original.amount)}
                      </span>
                    ),
                  },
                  {
                    accessorKey: "recurring",
                    header: "Recurring",
                    cell: ({ row }) =>
                      row.original.recurring ? (
                        <Badge variant="neutral" showDot={false} className="text-xs">
                          Yes
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      ),
                  },
                  {
                    accessorKey: "status",
                    header: "Status",
                    cell: ({ row }) => (
                      <Badge
                        variant={
                          EXPENSE_STATUS_VARIANT[row.original.status] ?? "neutral"
                        }
                        showDot={false}
                        className="text-xs"
                      >
                        {EXPENSE_STATUS_LABEL[row.original.status] ??
                          row.original.status}
                      </Badge>
                    ),
                  },
                  {
                    id: "actions",
                    header: "",
                    enableSorting: false,
                    cell: ({ row }) => {
                      const e = row.original;
                      const isOwner = e.createdById === userId;
                      const canApprove = can(Permission.EXPENSE_APPROVE);
                      const canManage = can(Permission.FINANCE_MANAGE);
                      // Server locks edits on SUBMITTED/APPROVED expenses unless
                      // the actor can approve — only surface Edit when the PUT
                      // would actually succeed (DRAFT/REJECTED, or an approver).
                      const isEditable =
                        e.status === "DRAFT" ||
                        e.status === "REJECTED" ||
                        canApprove;
                      const groups: ActionMenuGroup[] = [
                        {
                          items: [
                            ...(canManage && isEditable
                              ? [
                                  {
                                    label: "Edit",
                                    icon: Pencil,
                                    onClick: () => handleEditExpense(e),
                                  },
                                ]
                              : []),
                            ...(canManage
                              ? [
                                  {
                                    label: "Duplicate",
                                    icon: Copy,
                                    onClick: () => handleDuplicateExpense(e),
                                  },
                                ]
                              : []),
                          ],
                        },
                        {
                          // Approval workflow actions.
                          items: [
                            ...(canManage &&
                            isOwner &&
                            (e.status === "DRAFT" || e.status === "REJECTED")
                              ? [
                                  {
                                    label: "Submit for approval",
                                    icon: Send,
                                    onClick: () =>
                                      submitExpenseMutation.mutate(e.id),
                                  },
                                ]
                              : []),
                            ...(canApprove && e.status === "SUBMITTED"
                              ? [
                                  {
                                    label: "Approve",
                                    icon: Check,
                                    onClick: () =>
                                      decideExpenseMutation.mutate({
                                        id: e.id,
                                        action: "approve",
                                      }),
                                  },
                                  {
                                    label: "Reject",
                                    icon: X,
                                    onClick: () =>
                                      decideExpenseMutation.mutate({
                                        id: e.id,
                                        action: "reject",
                                      }),
                                  },
                                ]
                              : []),
                          ],
                        },
                        {
                          items: [
                            ...(canManage
                              ? [
                                  {
                                    label: "Delete",
                                    icon: Trash2,
                                    variant: "destructive" as const,
                                    onClick: () =>
                                      handleDeleteExpense(e.id),
                                  },
                                ]
                              : []),
                          ],
                        },
                      ];
                      return (
                        <div className="flex justify-end group/action">
                          <ActionMenu groups={groups}>
                            <span />
                          </ActionMenu>
                        </div>
                      );
                    },
                  },
                ] satisfies ColumnDef<Expense>[]
              }
              data={expenses}
              emptyState={<EmptyState title="No expense entries yet." />}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  icon,
  accent,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        {icon}
      </div>
      <span className={`text-2xl font-bold ${accent}`}>{value}</span>
    </div>
  );
}
