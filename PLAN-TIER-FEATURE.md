# Plan-tier rework — BASIC / TEAM / ENTERPRISE

Simplify the org **billing `Plan`** enum, default everything to `ENTERPRISE`, backfill
every org to `ENTERPRISE`, and add a **platform-admin-only** way to change a plan.
`Plan` drives FEATURES; the separate `tenantClass` (GOV/COMMERCIAL data-classification)
is **unchanged** and was not touched.

## Investigation (read-only) findings

### Old `Plan` enum
- Definition: `prisma/schema.prisma:15` — `enum Plan { FREE TEAM BUSINESS ENTERPRISE GOV }`.
- Column: `prisma/schema.prisma:179` — `plan Plan @default(FREE)`.
- Postgres type: `"public"."Plan"` (baseline `prisma/migrations/20260525000000_baseline/migration.sql:56`);
  column `"plan" "public"."Plan" NOT NULL DEFAULT 'FREE'` (`:523`). Live e2e DB confirmed
  enum labels `FREE,TEAM,BUSINESS,ENTERPRISE,GOV`; 1 org, `plan=FREE`.

### Every reference to a **removed** Plan value in code (all updated)
- `src/app/api/v1/orgs/route.ts:143` — `if (org.plan === "GOV")` → **migrated to
  `org.tenantClass === "GOV"`** (see below). This is a hard `tsc` break once `GOV` leaves
  the enum.
- `src/app/api/v1/orgs/route.ts:9,19,110` — create-time `plan` handling: `import { Plan }`,
  `plan: z.nativeEnum(Plan).optional()` in `createOrgSchema`, and `...(data.plan ? {plan}:{})`
  in the create. **Removed** — new orgs take the `@default(ENTERPRISE)`; plan is never
  org-owner self-service (requirement #3).
- `prisma/seed/eso.ts:233` — `plan: "BUSINESS"` (typed Prisma `create`) → `"ENTERPRISE"`.
- `prisma/seed/demo-defense.ts:132,133` — `plan: "GOV"` (typed Prisma `update`/`create`) →
  `"ENTERPRISE"`; also the `console.log` label (`:432`), the audit-metadata string (`:397`),
  and the section comment (`:123`). The org sets **no** explicit `tenantClass`, so it stays
  GOV-classified via the schema's fail-closed `@default(GOV)` — its regulated-ness is preserved.
- `prisma/seed/bootstrap-org.ts:32,33` — `ORG_PLAN` default `"BUSINESS"` → `"ENTERPRISE"`
  (+ comment). (Line 134 casts via `as`, so it was a runtime-only correctness fix, not `tsc`.)
- `src/app/(dashboard)/[orgSlug]/settings/organization/page.test.tsx:126` — fixture
  `plan: "FREE"` → `"ENTERPRISE"`.

### Plan **display** surfaces (no change needed — all render the raw string)
`src/app/(dashboard)/page.tsx:39`, `src/app/(dashboard)/[orgSlug]/page.tsx:133,154` (homepage
badge/StatCard), `src/components/orgs/org-picker-grid.tsx:145`,
`src/components/settings/org-general-settings.tsx:168` (read-only "Plan" metadata), plus the
`plan: string` prop types — all use `.toLowerCase()` on the string with no value-specific
branching, so they now show `basic/team/enterprise` with zero code change and no `tsc` break.

### How I handled `plan === "GOV"`
The branch provisions the NIST 800-171 / CMMC L2 compliance baseline for "regulated (GOV)
orgs" (`provisionComplianceBaseline`, idempotent upsert). Its intent is **data-classification**
(regulated), which is exactly what `tenantClass` (GOV/COMMERCIAL) now owns — not billing.
So I migrated the key to **`org.tenantClass === "GOV"`**. Consequence to note: `tenantClass`
defaults to `GOV` (fail-closed), so newly-created orgs now provision the baseline by default
(previously only when a caller explicitly passed `plan:"GOV"`). This is consistent with the
tenant-class design ("new orgs are GOV until set otherwise; regulated orgs get the baseline
on day one") and the call is best-effort + idempotent.

### Platform-admin surface of the internal tenant-class control
`src/app/api/internal/orgs/[orgId]/tenant-class/route.ts` is **API-only** — gated by
`requirePlatformOwner()` → `isInternalAdmin(user.email, process.env.INTERNAL_ADMINS)`. There is
**no internal-admin UI page** consuming it (`src/app/internal/` holds only the design-system;
only the route + its test reference `internal/orgs`). The owner-facing tenant-class UI
(`org-tenant-class.tsx`, `runtime-config-panel.tsx`) targets the *v1* tighten-only route, not
the internal one. **Mirroring the internal control therefore means API-only**, which also
satisfies "NOT owner-settable" — adding an owner UI would violate the requirement.

## Migration approach
`prisma/migrations/20260713170000_simplify_plan_tiers/migration.sql` (timestamp after the
DB's latest applied migration `20260713160000`; the shared e2e DB already had migrations newer
than this worktree's folder). Postgres can't `DROP` enum values, so the type is recreated:
1. `ALTER COLUMN plan DROP DEFAULT` (default references the old type, blocks the cast).
2. `ALTER TYPE "Plan" RENAME TO "Plan_old"`.
3. `CREATE TYPE "Plan" AS ENUM ('BASIC','TEAM','ENTERPRISE')`.
4. `ALTER COLUMN plan TYPE "Plan" USING (CASE plan::text ... END)::"Plan"` — FREE→BASIC,
   TEAM→TEAM, BUSINESS/ENTERPRISE/GOV→ENTERPRISE.
5. `ALTER COLUMN plan SET DEFAULT 'ENTERPRISE'`.
6. `DROP TYPE "Plan_old"`.
7. `UPDATE "organizations" SET "plan"='ENTERPRISE'` — backfill **all** orgs to ENTERPRISE.

Applied to the e2e DB via `prisma db execute` + `prisma migrate resolve --applied`, then
`prisma generate`. **Verified**: enum = exactly `BASIC,TEAM,ENTERPRISE`; column default
`'ENTERPRISE'::"Plan"`; every org `ENTERPRISE`; `Plan_old` dropped.

> Env note: `node_modules/.prisma/client` is shared (worktree `node_modules` symlinks to
> cosmos-v2). The cosmos-v2 **main** checkout's schema still has the old 5-value enum, so a
> concurrent `prisma generate` there can clobber the shared client. The durable source of
> truth is this branch's committed schema + migration; re-run `prisma generate` from the
> worktree before typecheck if needed.

## Platform-admin plan control
`src/app/api/internal/orgs/[orgId]/plan/route.ts` — mirrors the internal tenant-class route
exactly: `requirePlatformOwner()` gate (`isInternalAdmin`), `GET` returns
`{id,slug,name,plan}`, `PATCH` validates `z.enum(["BASIC","TEAM","ENTERPRISE"])`, updates
`organization.plan`, and audits `plan.changed` (`{from,to,by:"platform_owner"}`). A
tenant-admin can never reach it (lives under `/api/internal`). **API-only** — no owner UI
(the faithful mirror of the tenant-class control, and required by "NOT owner-settable").

## Files
Schema/DB: `prisma/schema.prisma`, `prisma/migrations/20260713170000_simplify_plan_tiers/migration.sql`.
Code: `src/app/api/v1/orgs/route.ts`, `src/app/api/internal/orgs/[orgId]/plan/route.ts`.
Seeds: `prisma/seed/eso.ts`, `prisma/seed/demo-defense.ts`, `prisma/seed/bootstrap-org.ts`.
Tests: `src/app/api/internal/orgs/[orgId]/plan/route.test.ts`,
`src/lib/org/plan-tiers.migration.test.ts`,
`src/app/(dashboard)/[orgSlug]/settings/organization/page.test.tsx` (fixture).

## Tests
- **Plan route** (`plan/route.test.ts`): platform-owner sets a valid plan (+`plan.changed`
  audit with from/to); accepts every new-enum value (TEAM); non-signed-in → 403;
  tenant-admin (not internal) → 403; invalid/legacy value (`"GOV"`) → 400.
- **Migration/backfill** (`plan-tiers.migration.test.ts`, real e2e DB): enum is exactly
  `BASIC,TEAM,ENTERPRISE`; no legacy `FREE/BUSINESS/GOV`; every org `ENTERPRISE`; default
  is `ENTERPRISE`.
- **Org settings page** fixture updated (`FREE`→`ENTERPRISE`).
- Result: 23/23 passing across these + the internal tenant-class regression; `tsc --noEmit`
  clean.
