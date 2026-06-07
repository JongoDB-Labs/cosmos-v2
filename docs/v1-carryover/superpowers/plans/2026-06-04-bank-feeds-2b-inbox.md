# Bank Feeds 2b — Transaction Inbox + Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn imported `BankTransaction`s into posted Expenses. A per-account review queue (API + UI) where each transaction is **categorized** (→ creates an Expense → which posts to the GL), **matched** (→ linked to an existing Expense), or **excluded** — completing import → reconcile → ledger.

**Architecture:** A thin reconcile service (`src/lib/bank/reconcile.ts`) drives the `BankTransaction` state machine (`IMPORTED → POSTED|MATCHED|EXCLUDED`); categorize creates an `Expense` (status `APPROVED`) and posts it to the GL via the existing `postExpenseToLedger` helper (1b-ii) — reusing the ledger entirely. The inbox UI mirrors `accounting-dashboard.tsx`. Money is `Decimal` (string on the wire → `Number()` for display).

**Tech Stack:** Next.js, Prisma, the 2a `src/lib/bank/*` + the ledger `src/lib/ledger/auto-post.ts`, React Query. **Spec:** `docs/superpowers/specs/2026-06-04-bank-feeds-design.md` (§4). **Base:** `origin/main` (≥ v4.4.0, has bank 2a + the GL). **Bump:** minor → **4.5.0**. No migration.

## File Structure
- `src/lib/bank/reconcile.ts` — `suggestCategory` + `categorizeTransaction` / `matchTransaction` / `excludeTransaction` (Task 1).
- `src/app/api/v1/orgs/[orgId]/bank-accounts/[bankAccountId]/transactions/route.ts` (GET queue) (Task 1).
- `src/app/api/v1/orgs/[orgId]/bank-transactions/[txnId]/{categorize,match,exclude}/route.ts` (POST) (Task 1).
- `src/app/(dashboard)/[orgSlug]/finance/banking/page.tsx` + `src/components/banking/banking-inbox.tsx` (Task 2) + nav.

> ⚠️ local `DATABASE_URL` is PRODUCTION — no `prisma migrate/db`.

---

### Task 1: Reconcile service + API

**Files:** Create `src/lib/bank/reconcile.ts` (+ a small `reconcile.test.ts` for the pure `expenseAmountFor`), and the 4 routes.

- [ ] **Step 1: `src/lib/bank/reconcile.ts`:**
```ts
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { postExpenseToLedger, safeAutoPost } from "@/lib/ledger/auto-post";

/** Expense magnitude for a (signed) bank amount: outflows (negative) → positive expense. */
export function expenseAmountFor(amount: Prisma.Decimal): Prisma.Decimal {
  return amount.isNegative() ? amount.negated() : amount;
}

/** Suggest a category from the most recent Expense whose vendor/description resembles this text. */
export async function suggestCategory(orgId: string, description: string): Promise<string | null> {
  const token = description.trim().split(/\s+/)[0];
  if (!token) return null;
  const prior = await prisma.expense.findFirst({
    where: { orgId, OR: [{ vendor: { contains: token, mode: "insensitive" } }, { description: { contains: token, mode: "insensitive" } }] },
    orderBy: { createdAt: "desc" }, select: { category: true },
  });
  return prior?.category ?? null;
}

async function loadTxn(orgId: string, txnId: string) {
  const txn = await prisma.bankTransaction.findFirst({ where: { id: txnId, orgId } });
  if (!txn) throw new Error("Bank transaction not found");
  if (txn.status === "POSTED" || txn.status === "MATCHED") throw new Error("Transaction already reconciled");
  return txn;
}

/** Categorize → create an APPROVED Expense from the txn + post it to the GL; mark the txn POSTED. */
export async function categorizeTransaction(orgId: string, txnId: string, category: string, createdById: string) {
  const txn = await loadTxn(orgId, txnId);
  const expense = await prisma.expense.create({
    data: {
      orgId, amount: expenseAmountFor(txn.amount), currency: "USD", date: txn.postedDate,
      category, vendor: txn.description || null, description: txn.description, status: "APPROVED", createdById,
    },
  });
  await safeAutoPost(() => postExpenseToLedger(expense), `expense ${expense.id}`);
  return prisma.bankTransaction.update({ where: { id: txn.id }, data: { status: "POSTED", matchedExpenseId: expense.id, category } });
}

/** Match → link the txn to an existing Expense (already posted); mark MATCHED. */
export async function matchTransaction(orgId: string, txnId: string, expenseId: string) {
  const txn = await loadTxn(orgId, txnId);
  const expense = await prisma.expense.findFirst({ where: { id: expenseId, orgId }, select: { id: true } });
  if (!expense) throw new Error("Expense not found");
  return prisma.bankTransaction.update({ where: { id: txn.id }, data: { status: "MATCHED", matchedExpenseId: expense.id } });
}

export async function excludeTransaction(orgId: string, txnId: string) {
  const txn = await loadTxn(orgId, txnId);
  return prisma.bankTransaction.update({ where: { id: txn.id }, data: { status: "EXCLUDED" } });
}
```
(Confirm `expenseAmountFor`/`suggestCategory` against the `Expense` model fields — read `prisma/schema.prisma` `model Expense`: `amount`/`currency`/`date`/`category`/`vendor`/`description`/`status`/`createdById`. `currency` from the bank account if you prefer.)

- [ ] **Step 2: tests** `src/lib/bank/reconcile.test.ts` — pure `expenseAmountFor`: a `Decimal("-42.50")` → `"42.5"`, a positive stays positive. (The DB functions are verified by the journey.) Run → implement → pass.

- [ ] **Step 3: the routes** (mirror the finance wrapper; gate `FINANCE_READ` for the GET, `FINANCE_MANAGE` for the POSTs; `await params` for `{orgId, bankAccountId}` / `{orgId, txnId}`):
  - `bank-accounts/[bankAccountId]/transactions/route.ts` GET: verify the account in the org; `const status = request.nextUrl.searchParams.get("status") ?? "IMPORTED"; const txns = await prisma.bankTransaction.findMany({ where: { orgId, bankAccountId, status: status as BankTxnStatus }, orderBy: { postedDate: "desc" } });` then attach a suggestion: `const withSuggest = await Promise.all(txns.map(async t => ({ ...t, suggestedCategory: await suggestCategory(orgId, t.description) })));` `return success({ data: withSuggest, total: withSuggest.length });`
  - `bank-transactions/[txnId]/categorize/route.ts` POST: zod `{ category: string (min 1) }` → `return success(await categorizeTransaction(orgId, txnId, category, ctx.userId));`
  - `bank-transactions/[txnId]/match/route.ts` POST: zod `{ expenseId: string }` → `matchTransaction`.
  - `bank-transactions/[txnId]/exclude/route.ts` POST → `excludeTransaction`.
- [ ] **Step 4:** `npx tsc --noEmit && npx vitest run src/lib/bank/` → clean + green. **Step 5:** `git add -A && git commit -m "feat(bank): reconcile service + transactions/categorize/match/exclude API"`

---

### Task 2: Inbox UI + nav

**Files:** Create `src/app/(dashboard)/[orgSlug]/finance/banking/page.tsx` + `src/components/banking/banking-inbox.tsx`; add nav.

- [ ] **Step 1:** the page mirrors `finance/accounting/page.tsx` (Suspense/auth pattern, `PageShell` title "Banking", render `<BankingInbox orgId={...} />`).
- [ ] **Step 2: `banking-inbox.tsx`** (mirror `accounting-dashboard.tsx` conventions — `useOrgQueryKey`, `jsonFetch`, `useOrgMutation`, `DataTable`, money via `Number()`):
  - A bank-account selector (query `GET /bank-accounts` → pick the active account; default the first).
  - The review queue: `GET /bank-accounts/[id]/transactions?status=IMPORTED` → a `DataTable` (Date · Description · Amount[`Number()`] · a category input pre-filled with `suggestedCategory`) with row actions: **Add as expense** (`useOrgMutation` POST `/bank-transactions/[id]/categorize` `{category}`), **Exclude** (POST `/exclude`). (Defer "Match to existing" to a follow-up — categorize + exclude cover v1.)
  - On a mutation success, `invalidate: [["bank", accountId, "transactions"]]` + a count/toast.
  - Empty state ("No transactions to review — import a statement."). Loading skeleton; `LoadError`.
- [ ] **Step 3:** add an "Banking" nav item → `/finance/banking` in `src/components/layouts/app-sidebar.tsx` (after Accounting; the single-highlight logic added in 1c already handles sub-routes).
- [ ] **Step 4:** `npx tsc --noEmit` → clean. **Step 5:** `git add -A && git commit -m "feat(bank): banking inbox UI (review queue → categorize/exclude) + nav"`

---

### Task 3: Gate + version bump

- [ ] **Step 1:** `npx tsc --noEmit && npm run lint && npx vitest run && npm run build` → all green (watch for the Cache-Components instant-validation error on the new page — add `unstable_instant` samples per `finance/page.tsx` only if it appears; the repo otherwise omits it). Fix only this-slice fallout.
- [ ] **Step 2:** `npm version minor --no-git-tag-version` (→ 4.5.0). **Step 3:** `git add -A && git commit -m "chore(release): 4.5.0 — bank transaction inbox + reconciliation"`

---

## Self-Review
**Spec coverage (§4):** review-queue API + categorize/match/exclude → Task 1 ✓ (reuses `postExpenseToLedger` → GL); inbox UI + nav → Task 2 ✓; the `IMPORTED→POSTED/MATCHED/EXCLUDED` state machine → the reconcile service ✓. **Deferred:** "Match to existing expense" UI (API present, UI later); inflow→Revenue categorization (v1 = Expense/outflow focus); ML category suggestion (v1 = last-similar-vendor heuristic); reconciliation report (feed-vs-book balance).
**Placeholder scan:** none — the reconcile service + routes are given; the UI mirrors `accounting-dashboard.tsx` (read it for the exact import/prop shapes).
**Type consistency:** `categorizeTransaction`/`matchTransaction`/`excludeTransaction`/`suggestCategory`/`expenseAmountFor` (Task 1) consumed by the routes; `postExpenseToLedger`/`safeAutoPost` are the 1b-ii exports; the `Expense` create shape matches `model Expense`; money is `Prisma.Decimal`. The inbox reads `{data}` envelopes + bare amounts as strings (`Number()`).
**Note for execution:** worktree off `origin/main` (≥4.4.0). Reuse the ledger auto-post — a categorized bank txn becomes an APPROVED Expense that posts a balanced journal entry. Read `model Expense` for exact fields, and `accounting-dashboard.tsx` + `finance/accounting/page.tsx` for the UI/page patterns.
