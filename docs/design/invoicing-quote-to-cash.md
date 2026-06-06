# Design: Invoicing & Quote-to-Cash

> **Status:** Design proposal — needs sign-off before build · **Authored:** 2026-06-02
> Addresses the explicit ask **"invoice template creation/import"** and the roadmap's top-5 moat play **"Quote→Contract→Invoice→Payment in one tenant."** (See `docs/roadmap/cosmos-ai-first-roadmap.md`.)

## 1. Why this is a moat, not just a feature

Cosmos already owns every input to an invoice that normally forces a second vendor:
- the customer (`CrmContact`), the agreement (`Contract` + **DocuSign eSign** + **pdfkit PDF export**, already wired and in `serverExternalPackages`),
- the billable work (`TimeEntry` with `billableType` + `rate` + submit/approve), and
- revenue (`Revenue`) + expenses.

The seam where CRM (Salesforce CPQ) and billing (QuickBooks/Zoho) split into two products is exactly **quote → contract → invoice → payment**. Carrying a deal from pipeline to cash *without a re-keying handoff* is the deepest lock-in for services/ERP/A&E buyers — and it's mostly assembly of parts we already have.

## 2. Hard prerequisite — money correctness (Float → Decimal)

**This must land first** (or alongside) or every invoice compounds float drift. Today `Revenue.amount`, `Expense.amount`, `Contract.value`, `Product.price`, `TimeEntry.rate` are **`Float`**. Invoices sum line items, apply tax, and track partial payments — float rounding is unacceptable for money a customer is billed.

- Migrate money columns to **Prisma `Decimal`** (Postgres `numeric(14,2)` or store minor units as `Int` — decide at sign-off).
- Add a shared `money` util (add/multiply/round half-even, currency-aware) and forbid raw float math on money in lint.
- This is a **schema migration + a major version bump** (touches existing financial data). It is a gating migration, not optional cleanup. Sequencing: **Decimal migration → Invoice/Payment → rev-rec.**

## 3. Data model (new)

```prisma
model Invoice {
  id            String        @id @default(cuid())
  orgId         String
  number        String        // org-sequential, e.g. INV-2026-0042
  contactId     String?       // CrmContact (bill-to)
  contractId    String?       // optional source Contract
  status        InvoiceStatus @default(DRAFT) // DRAFT|SENT|PARTIAL|PAID|VOID|OVERDUE
  issueDate     DateTime?
  dueDate       DateTime?
  currency      String        @default("USD")
  subtotal      Decimal       @db.Decimal(14, 2)
  taxTotal      Decimal       @db.Decimal(14, 2)
  total         Decimal       @db.Decimal(14, 2)
  amountPaid    Decimal       @db.Decimal(14, 2) @default(0)
  notes         String?
  terms         String?       // payment terms text
  templateId    String?       // InvoiceTemplate used
  docusignEnvelopeId String?  // reuse the Contract eSign path
  pdfKey        String?       // storage key for the rendered PDF
  customFields  Json?         // optional ad-hoc fields (today's CustomField is org/project-scoped, NOT entity-scoped — add an invoice scope if needed)
  lineItems     InvoiceLineItem[]
  payments      Payment[]
  createdById   String
  createdAt     DateTime      @default(now())
  @@unique([orgId, number])
  @@index([orgId, status])
}

model InvoiceLineItem {
  id          String  @id @default(cuid())
  invoiceId   String
  description String
  quantity    Decimal @db.Decimal(14, 3) @default(1)
  unitPrice   Decimal @db.Decimal(14, 2)
  taxRate     Decimal @db.Decimal(6, 4)  @default(0) // 0.0825 = 8.25%
  amount      Decimal @db.Decimal(14, 2)            // qty * unitPrice
  productId   String?                                // optional Product link
  timeEntryId String?                                // optional source billable TimeEntry
  sortOrder   Int     @default(0)
}

model Payment {
  id          String   @id @default(cuid())
  orgId       String
  invoiceId   String
  amount      Decimal  @db.Decimal(14, 2)
  method      String   // "ach"|"card"|"check"|"wire"|"other"
  reference   String?
  receivedAt  DateTime
  createdById String
  createdAt   DateTime @default(now())
  @@index([orgId, invoiceId])
}

model InvoiceTemplate {
  id          String  @id @default(cuid())
  orgId       String
  name        String
  // header/footer, logo, default terms, default tax, line-item presets
  config      Json
  isDefault   Boolean @default(false)
  isBuiltIn   Boolean @default(false)
  @@unique([orgId, name])
}

// Quote/Estimate: same shape as Invoice with status QUOTE→ACCEPTED→(convert to Invoice).
model Quote { /* mirrors Invoice; `acceptedAt`, `convertedInvoiceId` */ }
```

### Optional but recommended: Account→Contact→Deal CRM split
Today `CrmContact` conflates person + deal, which caps invoicing (who is billed vs who is the buyer org?). A clean quote-to-cash wants `Account` (company, bill-to) → `Contact` (people) → `Deal` (opportunity → quote → contract → invoice). This is a **separate, coordinated migration** (CRM lens) — flag whether to do it before or after v1 invoicing. v1 can bill a `CrmContact` directly and add `Account` later.

## 4. The "creation" path (build)

- **Invoice builder UI** under Finance: pick contact/contract, add line items (manual, from a `Product`, or **"pull from approved billable TimeEntries"**), set tax/terms, preview, then **render PDF (reuse the Contract pdfkit pipeline)** and **send for eSign/record via the existing DocuSign envelope flow**.
- **`InvoiceTemplate`**: header/footer/logo/default-terms/tax presets, selectable per invoice (the "template creation" ask).
- **AI `draft_invoice` executor**: "invoice Acme for May" → pulls approved billable `TimeEntry` rows (rate × hours) into line items, applies the default template + tax, leaves a DRAFT for review. This is the differentiator — invoicing as a conversation over data we already hold.
- **Payments**: record full/partial payments → recompute `amountPaid`/`status`, post a `Revenue` row; **AR-aging** view; AI dunning drafts via the existing Gmail OAuth.

## 5. The "import" path (the other half of the explicit ask) — build vs integrate

"Invoice template **import**" → bring existing invoices/templates in from incumbents:
- **Zoho Books** — an MCP server is already available in this environment (`mcp__claude_ai_Zoho_Books__*` with `create_invoice`/`list_invoices`/`get_invoice`/estimates/POs/payments). Two paths:
  1. **Integrate**: keep Zoho as the books-of-record and sync; Cosmos drafts invoices and pushes via the MCP.
  2. **Seed/migrate**: one-time import of Zoho invoices/templates to **seed the native model**, then Cosmos becomes the system of record.
- **QuickBooks**: same build-vs-integrate decision.
- Reuse the existing **DOCX/JSON import** plumbing (`mammoth`) for template documents.

> **Decision needed at sign-off:** native invoicing as system-of-record (build) vs Zoho/QuickBooks as books-of-record (integrate + sync). The schema above assumes *build*; an integrate-first v1 would instead wrap the Zoho MCP and defer the native models.

## 6. API surface (new, mirroring existing finance routes)
`/orgs/[orgId]/finance/invoices` (GET/POST), `/invoices/[id]` (GET/PUT/DELETE), `/invoices/[id]/pdf`, `/invoices/[id]/send` (eSign), `/invoices/[id]/payments` (GET/POST), `/finance/quotes/*`, `/finance/invoice-templates/*`. Permissions: new `INVOICE_*` bits (mirror the existing finance permission pattern); approval gated through the now-shipped **ABAC engine** (`docs/design/work-role-abac-engine.md`) via `requireAccess`, so "who can issue/void an invoice" is policy, not hardcoded.

## 7. Risks & sequencing

| Risk | Mitigation |
|---|---|
| Float drift in money math | Decimal migration is a **hard prerequisite**; shared rounding util; lint ban on float money math. |
| Tax complexity (multi-jurisdiction) | v1: per-line manual tax rate. Defer automated tax (Avalara-style) to a later integration. |
| Invoice numbering races | Org-sequential number minted in a transaction (same pattern as `WorkItem.ticketNumber` / `Cycle.number`). |
| Build vs integrate churn | Decide §5 at sign-off before writing code. |
| Rev-rec coupling | Revenue recognition schedules are a **later** doc; don't block v1 invoicing on them. |

**Rollout:** (1) Decimal migration + money util (major bump). (2) `Invoice`+`InvoiceLineItem`+`Payment` + builder UI + PDF/eSign reuse. (3) `InvoiceTemplate` + `draft_invoice` AI executor. (4) Quotes + convert-to-invoice. (5) Import/sync per §5 decision. (6) AR-aging + dunning (needs the scheduler substrate).

**Open questions for sign-off:** (a) build vs integrate (§5); (b) Decimal vs minor-units Int; (c) Account/Deal CRM split now or later; (d) v1 tax scope.
