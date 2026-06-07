# Bank Feeds 2a — Foundation + Statement Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The statement-import foundation — `BankAccount`/`BankTransaction` models, OFX/QFX + CSV parsers (FITID dedup, TRNAMT sign), and an import endpoint that turns an uploaded statement into deduped `BankTransaction` rows. No inbox/UI yet (2b), no live aggregator (deferred).

**Architecture:** Pure parsers (`parseOfx`/`parseCsv` → a common `ParsedTxn[]`) are unit-tested with fixtures (incl. a non-unique-FITID + backwards-sign bank); a thin import service dedups via a fingerprint + the DB uniques and persists. Money is `Prisma.Decimal(19,4)` (Step 0). OFX via the zero-dependency `ofx-data-extractor`; CSV via the QBO 3/4-column layouts.

**Tech Stack:** Next.js, Prisma, `Prisma.Decimal`, `ofx-data-extractor` (new dep), Vitest. **Spec:** `docs/superpowers/specs/2026-06-04-bank-feeds-design.md` (§2–§3). **Base:** `origin/main` (≥ v4.3.0, GL spine complete). **Bump:** minor → **4.4.0** (new feature; additive migration). ⚠️ local `DATABASE_URL` is PRODUCTION — offline migration only, never `prisma migrate dev/deploy`/`db`.

## File Structure
- `prisma/schema.prisma` — `BankAccount` + `BankTransaction` + 2 enums (Task 1).
- `src/lib/bank/types.ts` — `ParsedTxn` (Task 2).
- `src/lib/bank/parsers/ofx.ts` + `csv.ts` (+ tests) (Task 2).
- `src/lib/bank/import.ts` — `fingerprintTxn` + `importTransactions` (Task 3).
- `src/app/api/v1/orgs/[orgId]/bank-accounts/route.ts` (GET/POST) + `[bankAccountId]/route.ts` (PUT) + `[bankAccountId]/import/route.ts` (POST) (Task 3).

---

### Task 1: Models + offline migration

**Files:** Modify `prisma/schema.prisma`; Create `prisma/migrations/<TS>_add_bank_feeds/migration.sql`.

- [ ] **Step 1: Add to `prisma/schema.prisma`:**
```prisma
enum BankAccountProvider { MANUAL_IMPORT AKOYA }
enum BankTxnStatus       { IMPORTED CATEGORIZED MATCHED POSTED EXCLUDED }

model BankAccount {
  id              String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId           String              @map("org_id") @db.Uuid
  name            String
  institution     String?
  mask            String?
  currency        String              @default("USD")
  provider        BankAccountProvider @default(MANUAL_IMPORT)
  ledgerAccountId String?             @map("ledger_account_id") @db.Uuid
  isActive        Boolean             @default(true) @map("is_active")
  createdById     String              @map("created_by_id") @db.Uuid
  createdAt       DateTime            @default(now()) @map("created_at")
  updatedAt       DateTime            @updatedAt @map("updated_at")
  transactions    BankTransaction[]
  @@index([orgId])
  @@map("bank_accounts")
}

model BankTransaction {
  id               String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId            String        @map("org_id") @db.Uuid
  bankAccountId    String        @map("bank_account_id") @db.Uuid
  externalId       String?       @map("external_id")
  fingerprint      String        @map("fingerprint")
  postedDate       DateTime      @db.Date @map("posted_date")
  amount           Decimal       @db.Decimal(19, 4)
  description      String        @default("")
  pending          Boolean       @default(false)
  status           BankTxnStatus @default(IMPORTED)
  matchedExpenseId String?       @map("matched_expense_id") @db.Uuid
  category         String?
  createdAt        DateTime      @default(now()) @map("created_at")
  account          BankAccount   @relation(fields: [bankAccountId], references: [id], onDelete: Cascade)
  @@unique([bankAccountId, externalId])
  @@unique([bankAccountId, fingerprint])
  @@index([orgId, bankAccountId, status])
  @@map("bank_transactions")
}
```
- [ ] **Step 2: Generate migration offline:** `git show HEAD:prisma/schema.prisma > /tmp/before-bank.prisma`; pick `<TS>` (14 digits, sorts after the newest existing); `npx prisma migrate diff --from-schema-datamodel /tmp/before-bank.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<TS>_add_bank_feeds/migration.sql`. VERIFY it only CREATEs the 2 enums + 2 tables + indexes + the cascade FK (no DROP/ALTER existing). **Note the nullable-`externalId` unique:** Postgres treats NULLs as distinct, so transactions with no FITID rely on the `(bankAccountId, fingerprint)` unique — that's intended.
- [ ] **Step 3:** `npx prisma generate && npx tsc --noEmit` → clean. **Step 4:** `git add prisma/schema.prisma prisma/migrations && git commit -m "feat(bank): BankAccount + BankTransaction models"`

---

### Task 2: Parsers (OFX + CSV) + types

**Files:** Create `src/lib/bank/types.ts`, `src/lib/bank/parsers/ofx.ts`, `src/lib/bank/parsers/csv.ts` + tests. Add the `ofx-data-extractor` dependency.

- [ ] **Step 1: Add the dep:** `npm install ofx-data-extractor` (zero-dependency TS OFX parser). Confirm it installs.
- [ ] **Step 2: `src/lib/bank/types.ts`:**
```ts
import type { Prisma } from "@prisma/client";
/** Normalized transaction from any statement format. amount is SIGNED, customer perspective (+ in / − out). */
export type ParsedTxn = {
  externalId: string | null;   // FITID (OFX) or null (CSV)
  postedDate: Date;
  amount: Prisma.Decimal;
  description: string;
};
```
- [ ] **Step 3: Write the failing parser tests** (`src/lib/bank/parsers/ofx.test.ts` + `csv.test.ts`) — use a small inline OFX fixture with two `<STMTTRN>` (one negative purchase, one positive payment) + a CSV fixture (3-col signed + 4-col Credit/Debit). Assert: OFX yields 2 `ParsedTxn` with the FITID as `externalId`, the signed `amount` (negative for the purchase), the `DTPOSTED` as `postedDate`; CSV 3-col maps the signed Amount, CSV 4-col maps Credit positive / Debit negative. Run → FAIL.
- [ ] **Step 4: `src/lib/bank/parsers/ofx.ts`:**
```ts
import { Prisma } from "@prisma/client";
import { Ofx } from "ofx-data-extractor";
import type { ParsedTxn } from "../types";

/** Parse an OFX/QFX statement into normalized transactions. TRNAMT is signed from the customer's
 *  perspective per the OFX spec — we trust it directly (NOT TRNTYPE) for cash-flow direction. */
export function parseOfx(content: string): ParsedTxn[] {
  const ofx = new Ofx(content);
  const txns = ofx.getBankTransferList(); // StatementTransaction[] — each has FITID, TRNAMT, DTPOSTED, MEMO/NAME
  return txns.map((t) => ({
    externalId: t.FITID ? String(t.FITID) : null,
    postedDate: parseOfxDate(String(t.DTPOSTED)),
    amount: new Prisma.Decimal(String(t.TRNAMT)),
    description: String((t as { NAME?: string; MEMO?: string }).NAME ?? (t as { MEMO?: string }).MEMO ?? "").trim(),
  }));
}

/** OFX dates are YYYYMMDD[HHMMSS][.XXX][TZ]; take the leading YYYYMMDD. */
function parseOfxDate(s: string): Date {
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
  return new Date(Date.UTC(y, m - 1, d));
}
```
(Confirm the `ofx-data-extractor` API against its types after install — `new Ofx(content)` + `getBankTransferList()`; adapt the constructor/method names to the actual exports. The library exposes `fromBuffer`/`fromBlob` helpers too.)
- [ ] **Step 5: `src/lib/bank/parsers/csv.ts`:**
```ts
import { Prisma } from "@prisma/client";
import type { ParsedTxn } from "../types";

export type CsvMapping = { date: number; description: number; amount?: number; credit?: number; debit?: number };

/** Minimal RFC-4180-ish CSV split (handles quoted fields + escaped quotes). */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ",") { cells.push(cur); cur = ""; } else cur += c;
    }
    cells.push(cur); rows.push(cells);
  }
  return rows;
}

/** Parse a QBO-style CSV. mapping picks columns; either a single signed `amount` col or `credit`/`debit` cols. */
export function parseCsv(text: string, mapping: CsvMapping, hasHeader = true): ParsedTxn[] {
  const rows = splitCsv(text);
  const body = hasHeader ? rows.slice(1) : rows;
  return body.map((r) => {
    let amount: Prisma.Decimal;
    if (mapping.amount != null) amount = new Prisma.Decimal((r[mapping.amount] || "0").replace(/[$,]/g, ""));
    else {
      const credit = new Prisma.Decimal((r[mapping.credit!] || "0").replace(/[$,]/g, "") || "0");
      const debit = new Prisma.Decimal((r[mapping.debit!] || "0").replace(/[$,]/g, "") || "0");
      amount = credit.minus(debit); // credit = inflow (+), debit = outflow (−)
    }
    return { externalId: null, postedDate: new Date(r[mapping.date]), amount, description: (r[mapping.description] || "").trim() };
  });
}
```
- [ ] **Step 6:** Run the parser tests → PASS; `npx tsc --noEmit` → clean. **Step 7:** `git add -A && git commit -m "feat(bank): OFX/QFX + CSV statement parsers (FITID, signed TRNAMT)"`

---

### Task 3: Import service + routes

**Files:** Create `src/lib/bank/import.ts`; the `bank-accounts` routes (list/create/update) + the import route.

- [ ] **Step 1: `src/lib/bank/import.ts`:**
```ts
import { createHash } from "crypto";
import { prisma } from "@/lib/db/client";
import type { ParsedTxn } from "./types";

/** Stable dedup fingerprint for transactions lacking a reliable FITID. */
export function fingerprintTxn(bankAccountId: string, t: ParsedTxn): string {
  return createHash("sha256").update(`${bankAccountId}|${t.postedDate.toISOString().slice(0, 10)}|${t.amount.toString()}|${t.description}`).digest("hex");
}

/** Persist parsed transactions, deduped by (externalId) and (fingerprint). Returns counts. */
export async function importTransactions(orgId: string, bankAccountId: string, parsed: ParsedTxn[]): Promise<{ imported: number; skipped: number }> {
  const data = parsed.map((t) => ({ orgId, bankAccountId, externalId: t.externalId, fingerprint: fingerprintTxn(bankAccountId, t), postedDate: t.postedDate, amount: t.amount, description: t.description }));
  const res = await prisma.bankTransaction.createMany({ data, skipDuplicates: true });
  return { imported: res.count, skipped: data.length - res.count };
}
```
- [ ] **Step 2: `bank-accounts/route.ts`** (GET list + POST create, gate `FINANCE_READ`/`FINANCE_MANAGE` — bank data is finance-sensitive; mirror the existing finance route wrapper). GET → `success({ data: accounts, total })`; POST (zod: name, institution?, mask?, currency?) → create with `createdById: ctx.userId`.
- [ ] **Step 3: `bank-accounts/[bankAccountId]/route.ts`** PUT (update name/institution/mask/isActive, `FINANCE_MANAGE`).
- [ ] **Step 4: `bank-accounts/[bankAccountId]/import/route.ts`** POST (`FINANCE_MANAGE`): read the multipart file + a `format` field (`ofx`|`csv`) + optional CSV `mapping`; `const text = await file.text()`; `const parsed = format === "ofx" ? parseOfx(text) : parseCsv(text, mapping)`; verify the bank account belongs to the org; `return success(await importTransactions(orgId, bankAccountId, parsed))`. Wrap in `handleApiError`.
- [ ] **Step 5:** `npx tsc --noEmit && npx vitest run src/lib/bank/` → clean + parser/fingerprint tests pass. **Step 6:** `git add -A && git commit -m "feat(bank): import service (dedup) + bank-accounts + import routes"`

---

### Task 4: Gate + version bump

- [ ] **Step 1:** `npx tsc --noEmit && npm run lint && npx vitest run && npm run build` → all green (fix only this-slice fallout; report pre-existing).
- [ ] **Step 2:** `npm version minor --no-git-tag-version` (→ 4.4.0). **Step 3:** `git add -A && git commit -m "chore(release): 4.4.0 — bank statement import"`

---

## Self-Review
**Spec coverage (§2–§3):** models → Task 1 ✓; OFX/CSV parsers + FITID/sign → Task 2 ✓; dedup fingerprint + import endpoint + bank-accounts CRUD → Task 3 ✓. **Deferred to 2b:** the inbox/review-queue API+UI + categorize/match→Expense→GL. **Deferred later:** Akoya live-feed + reconciliation report.
**Placeholder scan:** the `ofx-data-extractor` exact API (constructor/method names) is verify-at-install (Task 2 Step 4 says confirm against its types) — a precise instruction, not a placeholder; the migration timestamp is an `ls|sort` instruction.
**Type consistency:** `ParsedTxn` (Task 2) flows through `parseOfx`/`parseCsv` (Task 2) → `importTransactions`/`fingerprintTxn` (Task 3). Money is `Prisma.Decimal`; `BankTransaction.amount` is `Decimal(19,4)`. Follows the GL lesson: no `org Organization` FK (consistent with the sibling finance models).
**Note for execution:** worktree off `origin/main` (≥4.3.0). Verify the `ofx-data-extractor` API after install. Reuse the existing finance route wrapper (`finance/summary/route.ts`) for the routes.
