# Design: Auditable Time Tracking

> **Status:** Design proposal — needs sign-off before build · **Authored:** 2026-07-31
> Supersedes nothing. Slots **between** two existing designs: it consumes the
> work-role ABAC engine (`docs/design/work-role-abac-engine.md`, built) and the
> employee org chart (`docs/design/hr-onboarding-templates.md`, partly built),
> and it feeds `docs/design/invoicing-quote-to-cash.md` (built).

## 0. The one-paragraph version

Time tracking is already modelled, already permissioned, and already adjacent to
CLINs, pay runs and invoices. What it lacks is the thing that makes timekeeping
*evidence* rather than *notes*: a period-level unit of approval, a value-level
revision history, an approver relationship, and an immutable link from an
invoice line back to the hours behind it. This design adds those four things,
scoped so a commercial org and a government-contracting org can share one
codebase at different strictness levels. **Most of it is smaller than it looks**
— the ABAC engine already declares the supervisor predicate and fails closed
until it has data.

## 1. Fix first, independent of everything below

`GET /api/v1/orgs/[orgId]/time-entries` gates on `Permission.TIME_READ` and
applies no owner scoping. `userId` is an optional query filter; the client never
sends it (`time-tracker.tsx:187-194`), so the default response is **every time
entry in the org, each including `rate`**.

`TIME_READ` is held by `MEMBER` (`permissions.ts:288`) and `VIEWER`
(`permissions.ts:313`). Any read-only viewer can enumerate everyone's hours and
billing rates.

The write paths on the same resource are careful — `PUT`/`DELETE` both verify
`existing.userId === ctx.userId` and refuse non-`DRAFT` edits. Read never got the
same treatment.

**Fix (small, ship independently of this design):**
- Default the `where` to `userId: ctx.userId`.
- Widening to other users requires a new `TIME_READ_ALL` permission, *or* an
  `is_manager_of_assignee` relationship (§3), *or* project scope for a project
  approver.
- Strip `rate` from any payload whose caller lacks the rate-visibility grant
  (§4). Rate exposure is a separate decision from row visibility.

## 2. What already exists

Worth stating precisely, because it changes the size of this project.

| Concern | State |
|---|---|
| `TimeEntry` | **Built.** `hours Float`, `rate Decimal(19,4)`, `billableType`, `DRAFT→SUBMITTED→APPROVED/REJECTED`, optional `projectId`/`workItemId`/`clinId`/`payRunId` |
| `Employee` | **Built.** `costRate Decimal(19,4)`, `laborCategory String?`, `employmentType SALARY\|HOURLY`. **No `managerId`** |
| ABAC engine | **Built.** `is_manager_of_assignee` and `same_department` are declared predicates that deliberately stay *unresolved* — `require-access.ts:48-52` notes they have no backing data and the engine fails an unresolvable DENY closed |
| Invoicing | **Built.** `Invoice`, `InvoiceLineItem`, `Payment`. **`InvoiceLineItem` has no `timeEntryId`** |
| Contracting | **Built.** `Clin` (ceiling, funded value, POP), `Contract`, `PayRun`, `TaxRate`, `Expense`, `Revenue` |
| Connectors | **Built.** Registry, descriptors, sealed `ConnectorCredential`, Nango. No accounting connector |
| Permissions | **Built.** `TIME_CREATE/READ/UPDATE/DELETE/APPROVE`, `FINANCE_*`, `EXPENSE_APPROVE`, `ACCOUNTING_READ/MANAGE/CLOSE` |

Two of those are load-bearing for this design:

1. **`is_manager_of_assignee` already exists as a predicate with no data** — but
   it can only ever *narrow*. See the correction in §3.
2. **`ACCOUNTING_CLOSE` exists with nothing behind it.** Period locking has a
   permission waiting for an implementation.

## 3. Supervisors

> **Correction (2026-07-31, before build).** An earlier revision of this section
> claimed the supervisor feature was "a column plus a resolver" — resolve
> `is_manager_of_assignee` in `require-access.ts` and supervisors can read their
> reports' time. **That is wrong, and it would have shipped a feature that did
> nothing.**
>
> `abac/engine.ts:8` is explicit: *"ABAC rules can only NARROW, and v1 supports
> DENY rules only… An `allow` rule is INERT."* The decision is
> `RBAC-baseline AND NOT(any firing deny)`. A predicate can therefore only ever
> take access away. It can never grant a supervisor anything.
>
> `work-role.ts:58` closes the loop: `AUTHORABLE_RELATIONSHIPS` is
> `["owns_resource", "in_project"]`, so a policy naming `is_manager_of_assignee`
> is *rejected at authoring time*. Nothing depends on it today, which is why
> resolving it changes nothing on its own.
>
> Supervisor READ access is a **widening**, so it belongs in the route's scope
> computation, not in ABAC. The predicate's real use is §3.2 — narrowing who may
> *approve* — where "deny unless manager" is exactly the right shape.

Do **not** introduce a new supervisory-assignment model. The org chart already
has a designed and partly-built home.

```prisma
model Employee {
  // ... existing fields
  managerId String?    @map("manager_id") @db.Uuid   // -> Employee.id
  manager   Employee?  @relation("Reports", fields: [managerId], references: [id], onDelete: SetNull)
  reports   Employee[] @relation("Reports")

  @@index([orgId, managerId])
}
```

**Assignment is an admin/HR action, not self-service.** A worker who nominates
their own approver defeats the control. `managerId` is set on the employee
record under Finance → Payroll, which is `FINANCE_MANAGE`-gated — a high enough
bar, and the only employee-management surface that exists. (Conceptually this is
HR rather than payroll; splitting it out is a later concern, not a reason to
invent a second surface now.)

### 3.1 Supervisor READ — route-level widening

Per the correction above, this cannot go through ABAC. The list route resolves
the set of user ids the actor may read:

```
TIME_READ_ALL        → no userId filter at all
otherwise            → userId IN (self ++ direct reports)
```

Direct reports only. Walking the chain needs a depth cap against cycles, and
skip-level visibility is a policy question nobody has asked for — a manager two
levels up who needs it can be given `TIME_READ_ALL`.

**Supervisors still do not see rates.** `canSeeRate` is unchanged: own row, or
`FINANCE_READ`. A supervisor confirming hours has no business seeing the money,
and this is what keeps that true by default.

### 3.2 Supervisor APPROVAL — where the predicate earns its keep

Approval answers two different questions, often held by different people:

| Lane | Question | Who |
|---|---|---|
| **Labor** | Were these hours actually worked? | People manager |
| **Cost** | Are these hours chargeable to my project/CLIN? | Project or CLIN owner |

Collapsing them is how unallowable cost reaches a contract. `TimekeepingPolicy`
(§6) decides whether an org requires one lane or both; a small commercial org
runs labor-only and never sees the second.

Narrowing approval to "only this person's manager" IS a deny, so here the ABAC
predicate fits: resolve `is_manager_of_assignee` in `require-access.ts` (same
fail-closed contract as `in_project` — an error leaves it *unresolved*, never
`false`) and add it to `AUTHORABLE_RELATIONSHIPS` so a policy may name it.

Sequenced into slice 4, not slice 2: resolving a predicate that is currently
inert would *loosen* any deny that named it, so it should land together with
the authoring change and its own tests rather than ahead of them.

**Cycle safety.** `managerId` is a self-referential FK. Direct-reports-only
reads cannot loop, but a cycle is still nonsense data that would hang any later
org-chart rollup, so reject it at write time: no self-reference, and a bounded
upward walk to refuse a manager who already reports to this employee.

## 4. Rates — evolve `Employee.costRate`, don't replace it

`Employee.costRate` exists but is a **single current value**: no history, no bill
rate, no contract scoping. Three gaps, in priority order.

**Effective dating.** Re-costing an employee today silently rewrites the cost
basis of every past period. There is no effective-dated entity anywhere in the
schema yet, so this establishes the pattern — `effectiveFrom` inclusive,
`effectiveTo` exclusive, `null` meaning open-ended.

**Bill rate distinct from cost rate.** Cost drives CLIN burn and margin; bill
drives invoices. One number cannot do both, and conflating them is how a project
reads as profitable while losing money.

**Labor categories.** Contracts price *roles*, not people — "Senior Engineer
bills at $X." `Employee.laborCategory` is free text today; it should resolve to a
real `LaborCategory` scoped to a contract, so a CLIN can carry its own rate.

```prisma
model RateCard {
  id              String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId           String    @map("org_id") @db.Uuid
  // Resolution scope, most specific wins: employee > laborCategory > org default
  employeeId      String?   @map("employee_id") @db.Uuid
  laborCategoryId String?   @map("labor_category_id") @db.Uuid
  contractId      String?   @map("contract_id") @db.Uuid
  clinId          String?   @map("clin_id") @db.Uuid
  costRate        Decimal?  @map("cost_rate") @db.Decimal(19, 4)
  billRate        Decimal?  @map("bill_rate") @db.Decimal(19, 4)
  currency        String    @default("USD")
  effectiveFrom   DateTime  @map("effective_from") @db.Date
  effectiveTo     DateTime? @map("effective_to")   @db.Date
  createdById     String    @map("created_by_id") @db.Uuid
  createdAt       DateTime  @default(now()) @map("created_at")

  @@index([orgId, effectiveFrom])
  @@index([orgId, employeeId, effectiveFrom])
  @@map("rate_cards")
}
```

**Snapshot at approval, not at read.** `TimeEntry` keeps `costRate`, `billRate`
and the resolving `rateCardId` written **when the timesheet is approved**. An
entry approved in March at $150/hr must still read $150/hr after April's rate
change — otherwise reprinting an old invoice silently rewrites history. The
existing single `rate` column already had this instinct; it just had no card to
resolve from.

**Rate visibility is its own grant.** Cost rate is compensation data and more
sensitive than bill rate. `FINANCE_READ` covers bill rate; cost rate needs
either `FINANCE_MANAGE` or an explicit `RATE_COST_READ`. A supervisor approving
hours does not need to see either.

**Migration:** every existing `Employee.costRate` becomes one `RateCard` row with
`effectiveFrom` = employee `startDate` (or org creation date when null) and
`effectiveTo = null`. Keep `Employee.costRate` as a read-through cache of the
current card, or drop it once nothing reads it — decide at sign-off. Do **not**
migrate and drop in one release.

## 5. The audit spine

### 5.1 `Timesheet` — the unit of approval

Approving entry-by-entry doesn't scale, isn't how accounting or payroll think,
and isn't what "week to week" means.

```prisma
model Timesheet {
  id           String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId        String          @map("org_id") @db.Uuid
  userId       String          @map("user_id") @db.Uuid
  periodStart  DateTime        @map("period_start") @db.Date
  periodEnd    DateTime        @map("period_end")   @db.Date
  status       TimesheetStatus @default(OPEN)
  submittedAt  DateTime?       @map("submitted_at")
  // Two lanes (§3); a policy may require only the first.
  laborApprovedById String?    @map("labor_approved_by_id") @db.Uuid
  laborApprovedAt   DateTime?  @map("labor_approved_at")
  costApprovedById  String?    @map("cost_approved_by_id") @db.Uuid
  costApprovedAt    DateTime?  @map("cost_approved_at")
  rejectedReason    String?    @map("rejected_reason")
  // Worker's attestation, when policy requires it (§6).
  attestedAt        DateTime?  @map("attested_at")

  entries TimeEntry[]

  @@unique([orgId, userId, periodStart])
  @@index([orgId, status])
  @@map("timesheets")
}

enum TimesheetStatus {
  OPEN
  SUBMITTED
  LABOR_APPROVED   // lane 1 done, lane 2 outstanding
  APPROVED
  REJECTED
  LOCKED           // accounting period closed (§5.3)
}
```

`TimeEntry` gains `timesheetId` as a real FK, **lazily upserted** on first entry
in a period. Deriving the timesheet from a date range instead was considered and
rejected: approval state needs somewhere concrete to live, and a derived row
can't carry `submittedAt`.

Consequence worth stating: **changing an entry's date across a period boundary
reparents it.** That is a genuine business event, and it must be refused once
either timesheet is submitted.

Period length is configurable — weekly, bi-weekly, semi-monthly — because
payroll runs on those and `PayRun` already has `periodStart`/`periodEnd`.

### 5.2 `TimeEntryRevision` — values, not field names

`logAudit` records *that* `hours` changed, not *from what to what*. That's
insufficient: an auditor's question is "this row says 8 hours, what did it say
before, who changed it, and why?"

```prisma
model TimeEntryRevision {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String   @map("org_id") @db.Uuid
  timeEntryId String   @map("time_entry_id") @db.Uuid
  // Full prior-state snapshot. JSON keeps this stable as TimeEntry evolves;
  // a column-per-field table would need a migration every time a field is added.
  previous    Json
  changed     Json     // only the keys that moved
  reason      String?  // REQUIRED once the entry has left OPEN (§6)
  actorId     String   @map("actor_id") @db.Uuid
  actorIp     String?  @map("actor_ip")
  createdAt   DateTime @default(now()) @map("created_at")

  @@index([orgId, timeEntryId, createdAt])
  @@map("time_entry_revisions")
}
```

Append-only. No update or delete path — enforce with a table grant, not just
application code, since application code is one bug away from being bypassed.

### 5.3 Void, never delete

Hard deletion makes the dataset inadmissible: an auditor cannot distinguish
"never entered" from "deleted afterwards." `TimeEntry` gains `voidedAt`,
`voidedById`, `voidReason`, and every read path filters `voidedAt: null` by
default.

`DELETE` on the route keeps working for `OPEN` entries under a permissive policy
(§6) and becomes a void under a strict one. **Nothing that has been submitted is
ever removable**, at any strictness.

### 5.4 `AccountingPeriod` — a real lock behind `ACCOUNTING_CLOSE`

```prisma
model AccountingPeriod {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @map("org_id") @db.Uuid
  periodStart DateTime  @map("period_start") @db.Date
  periodEnd   DateTime  @map("period_end")   @db.Date
  closedAt    DateTime? @map("closed_at")
  closedById  String?   @map("closed_by_id") @db.Uuid

  @@unique([orgId, periodStart])
  @@map("accounting_periods")
}
```

Once closed, nothing dated inside it may be created, edited, voided or
reparented. Corrections post to the *current open* period referencing the
original — the standard accounting treatment, and the only one that keeps a
closed book closed.

## 6. `TimekeepingPolicy` — one codebase, two strictness levels

Per the sign-off decision, strictness is configurable rather than compiled in.

```prisma
model TimekeepingPolicy {
  id                    String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId                 String   @map("org_id") @db.Uuid
  contractId            String?  @map("contract_id") @db.Uuid  // null = org default
  periodLength          String   @default("WEEKLY") // WEEKLY|BIWEEKLY|SEMIMONTHLY
  requireCostApproval   Boolean  @default(false) @map("require_cost_approval")
  requireChangeReason   Boolean  @default(true)  @map("require_change_reason")
  requireAttestation    Boolean  @default(false) @map("require_attestation")
  allowDeleteWhileOpen  Boolean  @default(true)  @map("allow_delete_while_open")
  lateEntryWindowDays   Int?     @map("late_entry_window_days")
  flagBulkBackfill      Boolean  @default(false) @map("flag_bulk_backfill")

  @@unique([orgId, contractId])
  @@map("timekeeping_policies")
}
```

A government-contracting org turns on cost approval, attestation, no deletes and
backfill flagging. A commercial org leaves the defaults. **The audit spine of §5
is always on** — only the *friction* is configurable. Policy toggles what the
user must do, never whether the record is kept.

Resolution: contract-specific policy wins over org default. An entry with no
contract gets the org default.

## 7. Traceability to the invoice

`InvoiceLineItem` has no link to the time that produced it. Add:

```prisma
model InvoiceLineItem {
  // ... existing
  timeEntryId String? @map("time_entry_id") @db.Uuid
  timesheetId String? @map("timesheet_id") @db.Uuid
}
```

This closes the loop hours → timesheet → approval → invoice line → payment. It
is what lets you answer a client's "what is this $12,400 for?" without a
spreadsheet, and it was already anticipated by the invoicing design.

Invariant: **only `APPROVED` billable time may be drawn onto an invoice**, and an
entry already drawn cannot be voided — void the credit note instead.

## 8. `hours Float` → `minutes Int`

Float hours multiply against `Decimal` rates. `0.1 + 0.2 ≠ 0.3` in binary
floating point, and the drift compounds across thousands of rows until an
invoice total disagrees with the sum of its own lines.

The invoicing design already established Float→Decimal as a gating prerequisite
and most money columns were migrated; `TimeEntry.hours` is the surviving leak.

Migrate as **add → dual-write → backfill → verify → cut over → drop**, not a
rename. `minutes Int` is exact, sums without rounding, and renders as hours at
the edge. Any timer feature writes it directly.

## 9. Information architecture

The current single 880-line `time-tracker.tsx` serves four audiences at once.
Split by *who is asking*:

**1. My Time** — the only screen most people ever open. Week grid: rows are
project/CLIN/task, columns are days. **Keyboard-first is non-negotiable** — this
is a chore performed 52 times a year, so every extra click is multiplied by
headcount and then by weeks. Tab across, type `8`, enter. "Copy last week."
Optional timer. **Rates never render here.**

**2. Approvals** — a *queue*, not a grid. "4 timesheets are waiting for you."
Each opens to a week view with variance against the person's prior weeks.
Rejection requires a reason, returns the sheet to `OPEN`, and shows the reason
on the row. Two lanes appear as two queues when policy requires both.

**3. Billing** — approved-and-unbilled work by client/contract/CLIN, with burn
against `Clin.fundedValue`, feeding invoice creation (§7).

**4. Reports & Audit** — utilization, realization, burn, and a searchable
revision history.

Plus **Settings**: rate cards, labor categories, policy, period configuration,
integrations.

### On "supervisors keeping tabs"

Build this as an **exception view**, not a surveillance grid: missing
timesheets, late submissions, and backfill patterns — 40 hours entered in one
sitting on a Friday night proves time was reconstructed rather than recorded
contemporaneously, which is a genuine audit red flag and exactly what
`flagBulkBackfill` detects.

This is more useful to a supervisor than reading everyone's rows, and it is a
better thing to build. A timekeeping system people resent is one they fill in
from memory on Friday — which is the data-quality problem the whole design
exists to solve. Adoption is the product.

**Explicitly not building:** a payroll engine, a general ledger, or activity
monitoring (screenshots/GPS). Cosmos is the system of record for *time* and
hands off to accounting.

## 10. Integrations — deferred, but don't foreclose

Per sign-off, no connector is built until the model settles. Two decisions to
preserve now so the later work is cheap:

- **Sync documents, not rows.** Push an *invoice* or a *bill*, never 4,000 time
  entries. Documents are what both systems agree on and what reconciles.
- **`ExternalRef`** — `(entity, entityId, system, externalId, syncedAt, status)`
  makes re-sync idempotent and proves what was pushed when a client disputes a
  number. Cheap to add now, painful to retrofit.

QuickBooks Online and Bill.com are both OAuth2 and fit the existing Nango +
sealed `ConnectorCredential` seam — no new credential handling, per ADR 0002.
The mapping layer (Project ↔ Customer:Job, LaborCategory ↔ Service Item, User ↔
Employee/Vendor) is the real work and depends on §4 existing.

## 11. Sequencing

Ordered by value per unit of risk. Each ships independently.

| # | Slice | Depends on |
|---|---|---|
| 1 | **Read scoping + rate redaction** (§1) | — |
| 2 | `Employee.managerId` + predicate resolver (§3) | — |
| 3 | `Timesheet` + revisions + void (§5.1, 5.2, 5.3) | — |
| 4 | Two-lane approval + `TimekeepingPolicy` (§3, §6) | 2, 3 |
| 5 | `minutes Int` migration (§8) | 3 |
| 6 | `RateCard` + cost/bill split (§4) | 3 |
| 7 | `AccountingPeriod` lock (§5.4) | 3 |
| 8 | `InvoiceLineItem.timeEntryId` (§7) | 3, 6 |
| 9 | My Time redesign (§9) | 3, 5 |
| 10 | Reports, exception view (§9) | 4, 6 |
| 11 | QuickBooks, then Bill.com (§10) | 6, 8 |

Slice 1 ships this week regardless of whether the rest is approved. Slices 2 and
3 are the spine; everything after is worth materially less without them.

Slice 9 deliberately comes *after* the model work. Redesigning the entry grid
against a model that's still moving means building it twice.

## 12. Risks and open questions

- **Schema change on live financial data.** `time_entries` has production rows.
  Every migration here is additive-then-backfill; per `AGENTS.md`, validate by
  applying to a scratch database and asserting the promised behaviour (defaults
  on existing rows, `ON DELETE` semantics), not merely that it applied.
- **`payRunId` has no FK by deliberate prod parity.** Don't "fix" it while
  nearby. It is documented as intentional in the schema.
- **Major version bump.** Timesheet + revisions changes DB schema; per `AGENTS.md`
  that is a major, and CI gates `package.json` against the changelog top entry.
- **Open — does `Employee` become mandatory?** Today `TimeEntry.userId` is a
  `User`; rate resolution and `managerId` both hang off `Employee`. Either
  every timekeeper needs an `Employee` row, or rate resolution needs a fallback.
  Recommend requiring `Employee` and auto-provisioning on first entry.
- **Open — semi-monthly periods split weeks.** A week spanning the 15th belongs
  to two periods. Either periods must align to weeks, or an entry's period is
  determined per-day. Recommend the latter; it matches how payroll actually
  computes.
- **Open — does the supervisor lane walk the org chart?** Direct manager only is
  simpler and cycle-safe. Skip-level approval, if wanted, is a policy flag.
