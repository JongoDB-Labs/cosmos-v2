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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { X } from "lucide-react";

const fmtCurrency = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);

type Contact = { id: string; name: string };

type LineRow = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRatePct: string;
};

const emptyLine = (): LineRow => ({
  description: "",
  quantity: "1",
  unitPrice: "",
  taxRatePct: "0",
});

export function InvoiceBuilderDialog({
  orgId,
  open,
  onOpenChange,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [contactId, setContactId] = useState<string>("");
  const [billToName, setBillToName] = useState("");
  const [billToEmail, setBillToEmail] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [terms, setTerms] = useState("");
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);

  const contactsKey = useOrgQueryKey("crm", "contacts");
  const contactsQ = useQuery({
    queryKey: contactsKey,
    enabled: open,
    queryFn: () => jsonFetch<Contact[]>(`/api/v1/orgs/${orgId}/crm/contacts`),
  });

  function reset() {
    setContactId("");
    setBillToName("");
    setBillToEmail("");
    setDueDate("");
    setTerms("");
    setLines([emptyLine()]);
  }

  const create = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contactId || null,
          billToName: billToName.trim(),
          billToEmail: billToEmail.trim() || null,
          dueDate: dueDate || null,
          terms: terms.trim() || null,
          lines: lines.map((l) => ({
            description: l.description.trim(),
            quantity: l.quantity || "1",
            unitPrice: l.unitPrice || "0",
            taxRate: (Number(l.taxRatePct) || 0) / 100, // percent → fraction
          })),
        }),
      }),
    invalidate: [["invoices"], ["invoices", "aging"]],
    onSuccess: () => {
      reset();
      onOpenChange(false);
    },
    onError: (e) => notifyError(e, "Couldn't create the invoice."),
  });

  // Live preview totals (display only — the server recomputes authoritatively).
  const computed = lines.map((l) => {
    const amount = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
    const tax = amount * ((Number(l.taxRatePct) || 0) / 100);
    return { amount, tax };
  });
  const subtotal = computed.reduce((a, c) => a + c.amount, 0);
  const taxTotal = computed.reduce((a, c) => a + c.tax, 0);

  const valid =
    billToName.trim() !== "" &&
    lines.length > 0 &&
    lines.every((l) => l.description.trim() !== "" && Number(l.unitPrice) >= 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New invoice</DialogTitle>
          <DialogDescription>
            Add a bill-to and line items. It&apos;s saved as a draft — send it to post to the ledger.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Bill-to */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Customer (CRM)</Label>
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={contactId}
                onChange={(e) => {
                  setContactId(e.target.value);
                  const c = (contactsQ.data ?? []).find((x) => x.id === e.target.value);
                  if (c) setBillToName(c.name);
                }}
              >
                <option value="">— free text —</option>
                {(contactsQ.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Bill-to name *</Label>
              <Input
                className="h-9"
                value={billToName}
                onChange={(e) => setBillToName(e.target.value)}
                placeholder="Acme Corp"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Bill-to email</Label>
              <Input
                className="h-9"
                type="email"
                value={billToEmail}
                onChange={(e) => setBillToEmail(e.target.value)}
                placeholder="ap@acme.com"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Due date</Label>
              <Input
                className="h-9"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          {/* Line items */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Line items</Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setLines((ls) => [...ls, emptyLine()])}
              >
                + Add line
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              {lines.map((line, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    className="h-8 flex-1"
                    placeholder="Description"
                    value={line.description}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, j) => (j === i ? { ...l, description: e.target.value } : l)),
                      )
                    }
                  />
                  <Input
                    className="h-8 w-16"
                    type="number"
                    step="0.01"
                    placeholder="Qty"
                    value={line.quantity}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, j) => (j === i ? { ...l, quantity: e.target.value } : l)),
                      )
                    }
                  />
                  <Input
                    className="h-8 w-24"
                    type="number"
                    step="0.01"
                    placeholder="Unit $"
                    value={line.unitPrice}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, j) => (j === i ? { ...l, unitPrice: e.target.value } : l)),
                      )
                    }
                  />
                  <Input
                    className="h-8 w-16"
                    type="number"
                    step="0.01"
                    placeholder="Tax %"
                    value={line.taxRatePct}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, j) => (j === i ? { ...l, taxRatePct: e.target.value } : l)),
                      )
                    }
                  />
                  <span className="w-20 text-right text-sm tabular-nums text-muted-foreground">
                    {fmtCurrency(computed[i].amount)}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={lines.length === 1}
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* Totals + terms */}
          <div className="flex items-end justify-between gap-4">
            <div className="flex flex-1 flex-col gap-1">
              <Label className="text-xs">Terms / notes</Label>
              <Input
                className="h-8"
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                placeholder="Net 30"
              />
            </div>
            <div className="text-sm tabular-nums">
              <div className="flex justify-between gap-8 text-muted-foreground">
                <span>Subtotal</span>
                <span>{fmtCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between gap-8 text-muted-foreground">
                <span>Tax</span>
                <span>{fmtCurrency(taxTotal)}</span>
              </div>
              <div className="flex justify-between gap-8 font-semibold">
                <span>Total</span>
                <span>{fmtCurrency(subtotal + taxTotal)}</span>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!valid || create.isPending} onClick={() => create.mutate()}>
              Create draft
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
