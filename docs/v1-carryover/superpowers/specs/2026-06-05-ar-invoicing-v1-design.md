# AR / Invoicing v1 (quote-to-cash core) — design

**Goal:** native invoicing as system-of-record on the Decimal + GL foundation: create invoices with line items, issue them (accrual GL), record payments, see AR aging.

**Status:** approved 2026-06-05 (core spine; bill-to = CrmContact; per-line manual tax; reuse FINANCE_READ/MANAGE). Base: `origin/main` @ 4.8.0. Supersedes `docs/design/invoicing-quote-to-cash.md` (#36) for v1 — its Decimal/GL/DocuSign/ABAC prerequisites are now shipped.

## Scope
**In (v1):** Invoice / InvoiceLineItem / Payment; org-sequential numbering; accrual GL posting; invoice + payment CRUD API; builder UI + payment recording + AR-aging panel.
**Fast-follow (out):** PDF (reuse `pdf/contract.ts`), AI `draft_invoice` from billable TimeEntries, Quotes + convert, InvoiceTemplate, eSign-send, dunning, scheduler-driven OVERDUE.

## Data model (our conventions: `@db.Uuid` / `gen_random_uuid()` / `Decimal(19,4)` / snake_case `@map`)
- **Invoice** — `number` (org-sequential `INV-<YYYY>-####`), `contactId String?` (→ CrmContact, bill-to), `billToName String` + `billToEmail String?` (denormalized; covers the free-text/ad-hoc fallback when `contactId` is null), `contractId String?`, `status InvoiceStatus @default(DRAFT)`, `issueDate`/`dueDate DateTime?`, `currency`, `subtotal`/`taxTotal`/`total`/`amountPaid Decimal`, `terms`/`notes String?`, `createdById`, timestamps. `lineItems[]`, `payments[]`. `@@unique([orgId, number])`, `@@index([orgId, status])`.
- **InvoiceLineItem** — `invoiceId`, `description`, `quantity Decimal(19,4) @default(1)`, `unitPrice Decimal(19,4)`, `taxRate Decimal(9,6) @default(0)` (0.0825 = 8.25%), `amount Decimal(19,4)` (qty×unitPrice), `productId String?`, `sortOrder Int`. Cascade-delete with the invoice.
- **Payment** — `orgId`, `invoiceId`, `amount Decimal(19,4)`, `method String` ("ach"|"card"|"check"|"wire"|"other"), `reference String?`, `receivedAt DateTime`, `createdById`. `@@index([orgId, invoiceId])`.
- **enum InvoiceStatus** { DRAFT SENT PARTIAL PAID VOID }. (OVERDUE is derived in v1 — `SENT/PARTIAL` past `dueDate` — not a stored state; scheduler-driven later.)

## Money math (`src/lib/invoicing/totals.ts`, PURE + tested)
- `lineAmount(qty, unitPrice) = roundMoney(multiplyMoney(unitPrice, qty))`
- `lineTax(amount, taxRate) = roundMoney(amount × taxRate)`
- `invoiceTotals(lines)` → `{ subtotal, taxTotal, total }` via `sumMoney` (Decimal; half-even round) — reuses `src/lib/money`.
- `statusFor(total, amountPaid, current)` → PAID (paid ≥ total), PARTIAL (0 < paid < total), else keep DRAFT/SENT (never downgrade a VOID).

## GL posting (`src/lib/invoicing/posting.ts` mappers PURE + tested; reuses ledger `postEntry`/`safeAutoPost` + `ACCOUNT_CODES`)
- **Issue** (DRAFT→SENT): `invoiceToPostingLines` → `DR Accounts Receivable (total)`, `CR Sales Revenue (subtotal)`, `CR Sales Tax Payable (taxTotal)` (tax line omitted when 0). source `INVOICE`, sourceId `invoice.id` (idempotent via `postEntry`).
- **Payment**: `paymentToPostingLines` → `DR Cash (amount)`, `CR Accounts Receivable (amount)`. source `PAYMENT`, sourceId `payment.id`.
- **Void**: `reverseEntry` the invoice's INVOICE entry (only if no payments; else block). Payments must be reversed/refunded first.
- All posting via `safeAutoPost` (ledger failure never breaks the source write; reconcilable via backfill). Needs `JournalEntrySource` to include `INVOICE` + `PAYMENT` (extend the enum/string).

## Service (`src/lib/invoicing/service.ts`)
- `createInvoice` / `updateInvoice` (DRAFT only) — recompute totals from line items in a tx.
- `mintInvoiceNumber(tx, orgId)` — `INV-<year>-<seq>`, seq = `count(orgId, year)+1` inside the same tx (race-safe via the unique constraint + retry; mirrors `entryNumber`).
- `sendInvoice` — DRAFT→SENT, set `issueDate`, `safeAutoPost(postInvoice)`.
- `recordPayment` — create Payment in a tx, recompute `amountPaid` + `statusFor`, then `safeAutoPost(postPayment)`. Guard: not on DRAFT/VOID; amount > 0; don't over-apply past `total` (warn, allow? v1: clamp-block over-payment).
- `voidInvoice` — guard no payments; status→VOID; `safeAutoPost(reverseInvoice)`.

## API (`/api/v1/orgs/[orgId]/invoices…`, mirrors finance routes; FINANCE_READ read / FINANCE_MANAGE write)
`GET/POST invoices` · `GET/PUT/DELETE invoices/[id]` (DELETE only DRAFT) · `POST invoices/[id]/send` · `POST invoices/[id]/void` · `GET/POST invoices/[id]/payments` · `GET invoices/aging` (AR-aging buckets: current / 1-30 / 31-60 / 61-90 / 90+ by `dueDate`).

## UI (`finance/invoices` page + components)
Invoices list (number, bill-to, status badge, total, balance) + builder dialog (bill-to picker from CrmContacts + free-text; line-item editor with live totals; terms/dates) + invoice detail (line items, payments, Record-payment, Send, Void) + an AR-aging summary panel. `useOrgQueryKey`/`useOrgMutation`; money string→`Number()` display.

## Build slices
- **AR-1 (backend):** models + migration + `JournalEntrySource` INVOICE/PAYMENT + `totals.ts` + `posting.ts` (mappers) + `service.ts` + API. Pure helpers unit-tested. → gate → review → PR → merge on green.
- **AR-2 (UI):** invoices list + builder + detail + payment + AR-aging. → gate → review → PR → merge on green.

## Tenancy / money
All queries org-scoped; payment/send/void re-verify the invoice's org. Numbering minted per-org. Money is `Decimal` server-side (string on wire); UI `Number()` display only; all line/tax/total math through `src/lib/money` (half-even) — no float.
