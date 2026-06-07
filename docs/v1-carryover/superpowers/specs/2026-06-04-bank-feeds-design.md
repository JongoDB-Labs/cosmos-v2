# Design: Bank Feeds — Statement Import + Reconciliation (Phase 2 of the Finance program)

> **Status:** Design — research-driven (deep-research `wtgtgscel`, 2026-06-04), approved direction (user chose "research first" then "build it"). · Builds on the completed GL spine (money foundation + double-entry ledger + auto-post, on `main` ≥ v4.3.0).

## 0. Verdict (from the research)
- **Aggregator = Akoya** for the eventual live opt-in (no-credential-sharing, 100%-API FDX **pass-through that does not store personal customer data**, SOC 2 Type II, bank-owned, self-service tier <10k connections). MX is #2 (data-warehousing, SOC2+PCI, US-only).
- **No aggregator is FedRAMP-authorized** (live FedRAMP Marketplace check: Plaid/Akoya/MX/Finicity/Yodlee all absent) → **statement-import is the only fully-defensible path for CUI tenants**. So **v1 = statement-import-first**; Akoya is a **deferred opt-in** live-feed for non-FedRAMP-gated orgs.
- Caveat: CUI is governed by NIST 800-171 / DFARS 252.204-7012 / CMMC, not strictly FedRAMP — whether a SOC2 + no-data-stored aggregator (Akoya) satisfies a given contract's CUI is a **legal/contractual determination** (open question; resolve before wiring Akoya).

## 1. Scope
**This phase (v1): statement-import + the transaction inbox + reconciliation into the existing Expense/GL.** No live aggregator, no inbound-webhook-auth, no scheduler (the live-feed path needs all three — deferred).

Decomposed into buildable slices (each its own spec-section → plan → PR):
- **2a — Foundation + import (backend):** `BankAccount` + `BankTransaction` models + migration; OFX/QFX + CSV parsers (lib) with FITID dedup; an import endpoint (upload statement → parse → create deduped `BankTransaction`s). + unit tests.
- **2b — Inbox + reconciliation (API + UI):** the per-account review-queue API + UI; categorize/match/add → create-or-link an `Expense` (which **already auto-posts to the GL** via the 1b-ii hook) → mark the transaction posted; exclude.
- **Later — Akoya live-feed:** a `BankFeedProvider` abstraction (v1 = `MANUAL_IMPORT`; Akoya implements live methods) + inbound-webhook-auth + scheduler + the compliance/contract determination.

## 2. Data model (2a)
```prisma
enum BankAccountProvider { MANUAL_IMPORT AKOYA }   // AKOYA reserved for the deferred live-feed
enum BankTxnStatus       { IMPORTED CATEGORIZED MATCHED POSTED EXCLUDED }

model BankAccount {
  id            String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId         String              @map("org_id") @db.Uuid
  name          String              // user label, e.g. "Ops Checking"
  institution   String?             // FI name
  mask          String?             // last 4
  currency      String              @default("USD")
  provider      BankAccountProvider @default(MANUAL_IMPORT)
  ledgerAccountId String?           @map("ledger_account_id") @db.Uuid  // optional link to the GL Cash account it reconciles to
  isActive      Boolean             @default(true) @map("is_active")
  createdById   String              @map("created_by_id") @db.Uuid
  createdAt     DateTime            @default(now()) @map("created_at")
  updatedAt     DateTime            @updatedAt @map("updated_at")
  transactions  BankTransaction[]
  @@index([orgId])
  @@map("bank_accounts")
}

model BankTransaction {
  id            String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId         String          @map("org_id") @db.Uuid
  bankAccountId String          @map("bank_account_id") @db.Uuid
  externalId    String?         @map("external_id")   // FITID (FI-issued)
  fingerprint   String          @map("fingerprint")   // sha256(bankAccountId|postedDate|amount|description) — dedup fallback
  postedDate    DateTime        @db.Date @map("posted_date")
  amount        Decimal         @db.Decimal(19, 4)    // signed, customer perspective (+ in / - out)
  description   String          @default("")
  pending       Boolean         @default(false)
  status        BankTxnStatus   @default(IMPORTED)
  matchedExpenseId String?      @map("matched_expense_id") @db.Uuid  // when matched/added to an Expense
  category      String?         // chosen/suggested category (for the Expense)
  account       BankAccount     @relation(fields: [bankAccountId], references: [id], onDelete: Cascade)
  @@unique([bankAccountId, externalId])   // FITID dedup within an account (NULLs distinct → fingerprint covers null-FITID)
  @@unique([bankAccountId, fingerprint])  // fallback dedup for missing/non-unique FITIDs
  @@index([orgId, bankAccountId, status])
  @@map("bank_transactions")
}
```

## 3. Import (2a)
- **Parsers** (`src/lib/bank/parsers/`): `parseOfx(buffer)` (wrap **`ofx-data-extractor`** — zero-dep TS — `getBankTransferList()` → normalize `{ externalId: FITID, postedDate: DTPOSTED, amount: TRNAMT (signed), description: NAME||MEMO }`; honor TRNAMT sign, tolerate non-conformant banks); `parseCsv(text, mapping)` (QBO 3-col signed-Amount + 4-col Credit/Debit; user-confirmable column mapping). Both → a common `ParsedTxn[]`.
- **Dedup:** compute `fingerprint = sha256(bankAccountId|postedDate|amount|description)`; insert with `skipDuplicates` against the two `@@unique`s. Re-importing the same statement is a no-op.
- **Endpoint:** `POST /orgs/[orgId]/bank-accounts/[id]/import` (multipart file + format hint) → parse → create deduped `BankTransaction`s → return `{ imported, skipped }`. Gated `FINANCE_MANAGE` (bank data is finance-sensitive). + `bank-accounts` CRUD (GET/POST/PUT).
- **Tests:** pure parser tests (OFX fixture incl. a non-unique-FITID + a backwards-sign bank; CSV 3-col + 4-col); the dedup fingerprint.

## 4. Inbox + reconciliation (2b)
- **API:** `GET /bank-accounts/[id]/transactions?status=IMPORTED` (the review queue); `POST /bank-transactions/[id]/categorize` (set category → create an `Expense` from the txn → which auto-posts to the GL → set status POSTED + `matchedExpenseId`); `POST /bank-transactions/[id]/match` (link to an existing `Expense` → status MATCHED/POSTED); `POST /bank-transactions/[id]/exclude`.
- **Suggested category:** v1 = a simple rule/heuristic (last category used for a similar `description`); ML-style suggestion later. (QBO's review-queue model.)
- **UI** (`finance/banking`): per-account review queue (date · description · amount · suggested category · [Add as expense] / [Match…] / [Exclude]); reuses `DataTable` + the finance patterns; offer the visual companion at build time if the queue UX needs it.
- Reconciliation report (feed-vs-book balance) — later.

## 5. Reuse / integration
- Reuses the **Expense** model + its **auto-post-to-GL** hook (1b-ii) — a reconciled bank transaction becomes an Expense, which already posts a balanced journal entry. No new ledger code.
- `BankAccount.ledgerAccountId` optionally links to the GL "Cash & Bank" account for a future feed-vs-book reconciliation.
- Money is `Decimal(19,4)` (Step 0); serialized as string on the wire (display via `Number()`).

## 6. Risks & deferred
| Risk / item | Disposition |
|---|---|
| Non-unique/backwards-sign bank exports | Fingerprint fallback + TRNAMT-sign honoring + test fixtures for known offenders. |
| `ofx-data-extractor` modest adoption (~1.3k/wk) | Zero-dep TS (good supply chain); production-harden + fixtures; wrap behind our `parseOfx` so it's swappable. |
| QFX vs OFX (Intuit `<INTU.BID>`) | Test QFX separately; same parser. |
| Live Akoya path | Deferred — needs `BankFeedProvider` abstraction + inbound-webhook-auth + scheduler + the CUI/contract determination. The `provider` enum + the parser abstraction leave room. |
| CSV Debit/Credit ambiguity | User-confirmable column mapping in the import UI. |

**Open questions for sign-off:** (a) the compliance gate for offering Akoya to defense orgs (NIST/CMMC-acceptable vs hard-FedRAMP) — deferred to the live-feed phase; (b) build 2a (foundation+import) first, then 2b (inbox+UI) — assumed yes.

## 7. Research provenance
`tasks/wtgtgscel.output` — verified: Akoya no-credential-sharing pass-through + SOC2 Type II + self-service tier; no aggregator in the FedRAMP Marketplace; OFX `<STMTTRN>`/FITID dedup + TRNAMT customer-signed; `ofx-data-extractor` shape; QBO CSV 3/4-col; QBO review-queue + ML-suggested-category model.
