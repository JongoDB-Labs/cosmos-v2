import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const params = z.object({ orgId: Uuid, invoiceId: Uuid });

const Item = z.object({
  source: z.enum(["bill", "expense"]),
  id: Uuid,
  label: z.string(),
  date: z.string().nullable(),
  cost: z.number().describe("The vendor's exact amount."),
  markup: z.object({ pct: z.number(), source: z.enum(["bill", "project", "org"]) }),
  markupAmount: z.number(),
  total: z.number().describe("cost + markupAmount: what the cost bills at."),
});

export const listInvoiceReimbursables = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/invoices/{invoiceId}/reimbursables",
  operationId: "listInvoiceReimbursables",
  summary: "The unbilled reimbursable costs a draft invoice can add",
  description: "The invoice's project's bills and reimbursable expenses no invoice has recovered yet, with the markup each bills at.",
  tags: ["Invoicing"],
  stability: "internal",
  // No API-key scope reaches finance: a signed-in member only.
  scopes: [],
  request: { params },
  responses: { 200: z.object({ items: z.array(Item), lines: z.enum(["one", "two"]) }) },
  errors: [401, 403, 404, 409],
});

export const addInvoiceReimbursables = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/invoices/{invoiceId}/reimbursables",
  operationId: "addInvoiceReimbursables",
  summary: "Add unbilled reimbursable costs to a draft invoice",
  description:
    "Adds each cost as a line at cost plus its markup (one line or two, by the org's preference) and records the invoice on the cost, so it is not billed twice. Omit both id lists to add all of them.",
  tags: ["Invoicing"],
  stability: "internal",
  scopes: [],
  request: {
    params,
    body: z.object({ billIds: z.array(Uuid).optional(), expenseIds: z.array(Uuid).optional() }),
  },
  responses: { 200: z.object({ added: z.number().int(), invoice: z.record(z.string(), z.unknown()) }) },
  errors: [400, 401, 403, 404, 409],
});
