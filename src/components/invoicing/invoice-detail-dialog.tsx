"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const fmt = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );

type LineItem = {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  amount: string;
};
type PaymentRow = {
  id: string;
  amount: string;
  method: string;
  receivedAt: string;
  reference: string | null;
};
type Invoice = {
  id: string;
  number: string;
  billToName: string;
  billToEmail: string | null;
  status: "DRAFT" | "SENT" | "PARTIAL" | "PAID" | "VOID";
  issueDate: string | null;
  dueDate: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  terms: string | null;
  lineItems: LineItem[];
  payments: PaymentRow[];
};

const STATUS_TONE: Record<string, BadgeVariant> = {
  DRAFT: "neutral",
  SENT: "progress",
  PARTIAL: "review",
  PAID: "done",
  VOID: "critical",
};

export function InvoiceDetailDialog({
  orgId,
  invoiceId,
  onOpenChange,
}: {
  orgId: string;
  invoiceId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("ach");

  const key = useOrgQueryKey("invoices", invoiceId ?? "");
  const invoiceQ = useQuery({
    queryKey: key,
    enabled: invoiceId !== null,
    queryFn: () => jsonFetch<Invoice>(`/api/v1/orgs/${orgId}/invoices/${invoiceId}`),
  });

  const invalidate = [
    ["invoices", invoiceId ?? ""],
    ["invoices"],
    ["invoices", "aging"],
  ];

  const send = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/invoices/${invoiceId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    invalidate,
    onError: (e) => notifyError(e, "Couldn't send the invoice."),
  });

  const pay = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/invoices/${invoiceId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: payAmount, method: payMethod }),
      }),
    invalidate,
    onSuccess: () => setPayAmount(""),
    onError: (e) => notifyError(e, "Couldn't record the payment."),
  });

  const voidIt = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/invoices/${invoiceId}/void`, { method: "POST" }),
    invalidate,
    onError: (e) => notifyError(e, "Couldn't void the invoice."),
  });

  const inv = invoiceQ.data;
  const balance = inv ? Number(inv.total) - Number(inv.amountPaid) : 0;

  return (
    <Dialog open={invoiceId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {inv ? `Invoice ${inv.number}` : "Invoice"}
            {inv && (
              <Badge variant={STATUS_TONE[inv.status] ?? "neutral"}>
                {inv.status}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {invoiceQ.isLoading || !inv ? (
          <Skeleton className="h-64 rounded-lg" />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex justify-between text-sm">
              <div>
                <div className="font-medium">{inv.billToName}</div>
                {inv.billToEmail && (
                  <div className="text-muted-foreground">{inv.billToEmail}</div>
                )}
              </div>
              <div className="text-right text-muted-foreground">
                {inv.issueDate && <div>Issued {new Date(inv.issueDate).toLocaleDateString()}</div>}
                {inv.dueDate && <div>Due {new Date(inv.dueDate).toLocaleDateString()}</div>}
              </div>
            </div>

            {/* Line items */}
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead className="border-b text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Description</th>
                    <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                    <th className="px-3 py-1.5 text-right font-medium">Unit</th>
                    <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lineItems.map((li) => (
                    <tr key={li.id} className="border-b last:border-0">
                      <td className="px-3 py-1.5">{li.description}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{Number(li.quantity)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmt(li.unitPrice)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmt(li.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-56 text-sm tabular-nums">
                <Row label="Subtotal" value={fmt(inv.subtotal)} muted />
                <Row label="Tax" value={fmt(inv.taxTotal)} muted />
                <Row label="Total" value={fmt(inv.total)} bold />
                <Row label="Paid" value={fmt(inv.amountPaid)} muted />
                <Row label="Balance" value={fmt(balance)} bold />
              </div>
            </div>

            {/* Payments */}
            {inv.payments.length > 0 && (
              <div className="text-sm">
                <div className="mb-1 text-xs font-medium text-muted-foreground">Payments</div>
                {inv.payments.map((p) => (
                  <div key={p.id} className="flex justify-between border-b py-1 last:border-0">
                    <span>
                      {new Date(p.receivedAt).toLocaleDateString()} · {p.method}
                      {p.reference ? ` · ${p.reference}` : ""}
                    </span>
                    <span className="tabular-nums">{fmt(p.amount)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap items-end justify-between gap-3 border-t pt-3">
              <div className="flex gap-2">
                {inv.status === "DRAFT" && (
                  <Button size="sm" disabled={send.isPending} onClick={() => send.mutate()}>
                    Send (post to ledger)
                  </Button>
                )}
                {(inv.status === "SENT" || inv.status === "PARTIAL" || inv.status === "DRAFT") &&
                  inv.payments.length === 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={voidIt.isPending}
                      onClick={() => voidIt.mutate()}
                    >
                      Void
                    </Button>
                  )}
              </div>
              {(inv.status === "SENT" || inv.status === "PARTIAL") && balance > 0 && (
                <div className="flex items-end gap-2">
                  <Input
                    className="h-8 w-28"
                    type="number"
                    step="0.01"
                    placeholder={`Pay (${fmt(balance)})`}
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                  />
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-sm"
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value)}
                  >
                    {["ach", "card", "check", "wire", "other"].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={pay.isPending || Number(payAmount) <= 0}
                    onClick={() => pay.mutate()}
                  >
                    Record payment
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  muted,
  bold,
}: {
  label: string;
  value: string;
  muted?: boolean;
  bold?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${muted ? "text-muted-foreground" : ""} ${
        bold ? "font-semibold" : ""
      }`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
