# Bank Feeds 2c — inflow guard + match UI (design)

**Goal:** make bank-transaction reconciliation **sign-aware** so inflows become Revenue (not Expense), and give the inbox a UI to **match** a transaction to an existing source record.

**Status:** approved 2026-06-05. Builds on 2b (`feat/bank-inbox`, v4.5.0). Base: `origin/main` @ 4.5.0.

## Problem

A `BankTransaction.amount` is signed customer-perspective: **negative = outflow** (money out), **positive = inflow** (money in). The 2b inbox only offers "Add as expense", which runs `expenseAmountFor` (absolute value) — so a **+$500 deposit becomes a +$500 Expense**, wrong-side in the books. Also `matchTransaction` exists but has **no UI** and matches Expenses only.

## Design

### 1. Schema (additive)
Add to `BankTransaction`:
```prisma
matchedRevenueId String? @map("matched_revenue_id") @db.Uuid
```
Mirrors the existing `matchedExpenseId` so an inflow links to its Revenue. Additive migration generated **offline** (`prisma migrate diff`, never `migrate dev` — the local DB is prod); it applies at the next coordinated deploy.

### 2. `reconcile.ts` — sign-aware
- `reconcileKind(amount): "expense" | "revenue"` — pure: `amount.isNegative() ? "expense" : "revenue"`. (Zero → revenue; the UI only offers Exclude for a zero-amount txn.)
- `revenueAmountFor(amount)` — pure: the positive inflow magnitude (`amount` as-is for ≥0).
- `categorizeTransaction(orgId, txnId, label, createdById)` keeps its **atomic status-claim** guard, but branches on `reconcileKind`:
  - **Outflow:** create APPROVED `Expense` (`expenseAmountFor`, `category = label`) → `postExpenseToLedger` → set `matchedExpenseId`. *(unchanged path)*
  - **Inflow:** create `Revenue` (`amount = revenueAmountFor`, **`client = label`**, `description = txn.description`, `type: ONE_TIME`) → `postRevenueToLedger` → set `matchedRevenueId`.
  - The txn's `category` column still stores `label` either way (the inbox's free-text input).
- `matchTransaction(orgId, txnId, targetType: "expense" | "revenue", targetId)` — unified: validate the target is in-org, set `matchedExpenseId` **or** `matchedRevenueId`, mark `MATCHED`. (TOCTOU-safe via the same status-scoped `updateMany` claim as categorize.)
- `listMatchCandidates(orgId, txn)` — returns the recent in-org source records of the **sign-appropriate** kind (Expenses for outflow, Revenues for inflow), sorted by closeness to `|txn.amount|`, capped (e.g. 25). One query.

### 3. API
- `POST bank-transactions/[txnId]/match` — body `{ targetType, targetId }`, `FINANCE_MANAGE`. (Was `{ expenseId }`.)
- `GET bank-transactions/[txnId]/candidates` — `FINANCE_READ`, returns `{ data: [{ id, kind, amount, date, label }] }` for the picker.

### 4. UI (`banking-inbox.tsx`)
- Primary action is **sign-aware**: `amount < 0` → **"Add as expense"**; `amount > 0` → **"Add as revenue"**. The inline text field relabels **Category** ↔ **Source**.
- New **"Match"** button per row → a compact `@base-ui` `Dialog` listing candidates (`amount · date · vendor|client · description`); click a candidate → `match` mutation → row leaves the queue (`MATCHED`). Per-row pending via react-query `.variables`.

## Tenancy / money
All reads/writes scoped to `{ id, orgId }`; match re-verifies the target's `orgId`. Money stays `Prisma.Decimal` (string on the wire); UI uses `Number()` for display only.

## Testing
Unit-test the pure helpers (`reconcileKind`, `revenueAmountFor`, `expenseAmountFor`). The DB-touching paths follow the reviewed 2b patterns (atomic claim, in-org scoping).

## Out of scope (later)
Bank "rules" auto-categorization; reconciliation report (feed balance vs book); matching to Invoices once AR ships; inflow→specific-CoA-account mapping.

**Ship:** subagent-quality-reviewed → gate (tsc/lint/vitest/build) → bump **4.6.0** → PR → merge on green. Deploy stays user-gated.
