# Payroll / HR v1 — labor distribution → GL (design)

**Goal:** an `Employee` comp model + post approved-time labor cost to the GL with project/cost dimensions (the DCAA foundation). The actual payroll run (gross→net, tax, filings) is deferred to a Gusto/ADP integration.

**Status:** approved 2026-06-05 (labor-distribution-first; reuse FINANCE_READ/MANAGE). Base: `origin/main` @ 4.10.0. Builds on existing `OrgMember` + `TimeEntry` (hours/rate/billable/approve) + the GL.

## Data model (our conventions; `Decimal(19,4)`)
- **enum EmploymentType** { SALARY HOURLY }
- **Employee** (1:1 enrich of an org's user): `orgId`, `userId`, `employmentType`, **`costRate Decimal`** (hourly **cost** rate — distinct from `TimeEntry.rate`, the **bill** rate), `laborCategory String?` + `classification String?` (DCAA/FLSA), `status` (active/…), `startDate`/`endDate Date?`, `createdById`. `@@unique([orgId, userId])`.
- **enum PayRunStatus** { DRAFT POSTED }
- **PayRun**: `orgId`, `label`, `periodStart`/`periodEnd Date`, `status`, `laborCost Decimal @default(0)` (total posted), `postedAt`, `createdById`. `@@index([orgId, status])`.
- **TimeEntry** += `payRunId String?` (set when distributed — so a run only gathers approved, **un-distributed** entries; prevents double-counting).
- **JournalSource** += `PAYROLL`.
- **CoA** += `LABOR_EXPENSE "6100"` (EXPENSE) + `ACCRUED_PAYROLL "2200"` (LIABILITY).

## Labor distribution (`src/lib/payroll/`)
- `laborCostFor(hours, costRate)` (PURE, tested) = `roundMoney(multiplyMoney(costRate, hours))`.
- `summarizeLabor(entries, costRateByUser)` (PURE, tested) → `{ byProject: [{projectId, cost}], total }` — group approved entries by `projectId`, cost each at its employee's `costRate`, drop entries with no employee/cost-rate (reported as `unpriced`).
- `postPayRun(orgId, payRunId, createdById)`: in a tx, gather APPROVED + `payRunId: null` `TimeEntry`s in `[periodStart, periodEnd]`; resolve each user's `Employee.costRate`; build a single balanced `JournalEntry` — one **`DR Labor Expense`** line per project (tagged `projectId` + nullable DCAA dims) + one **`CR Accrued Payroll`** line for the total; mark those entries `payRunId`; set the PayRun POSTED + `laborCost`. Idempotent on `(orgId, source PAYROLL, sourceId payRunId)` via `postEntry`; entries with no priced employee are skipped + surfaced.

## API (`/api/v1/orgs/[orgId]/…`; FINANCE_READ/MANAGE, org-scoped)
`employees` (GET/POST) + `employees/[id]` (GET/PUT) · `pay-runs` (GET/POST) + `pay-runs/[id]` (GET) + `pay-runs/[id]/preview` (GET — labor summary, no write) + `pay-runs/[id]/post` (POST) · `payroll/labor-by-project` (GET — posted labor cost grouped by project).

## UI (P-2, next slice)
Employees list + comp editor; Payroll page (create a period → preview labor cost by employee/project → Post run); labor-cost-by-project panel.

## Build slices
- **P-1 (this):** models + migration + CoA/enum + `laborCostFor`/`summarizeLabor` (pure, tested) + `postPayRun` + API.
- **P-2:** Employees + Payroll UI + nav.

## Notes / v1 simplifications
`costRate` is an **hourly** cost rate for both hourly + salaried (a salaried employee's effective hourly cost is entered/derived; true salary-spread allocation is later). `TimeEntry.hours` stays Float (quantity); `multiplyMoney` keeps the cost exact. Tenancy: all org-scoped; cost rate from the in-org Employee. Reuses the JournalLine DCAA dimension tags (projectId now; costObjectiveId/costPoolId wired nullable for the later DCAA engine).
