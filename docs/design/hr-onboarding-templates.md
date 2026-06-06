# Design: HR Onboarding Templates (and the People foundation)

> **Status:** Design proposal — needs sign-off before build · **Authored:** 2026-06-02
> Addresses the explicit ask **"automated onboarding procedures/templates to be defined/set by HR for new hires."** Depends on the **work-role ABAC engine** (`docs/design/work-role-abac-engine.md`, now shipped) for HR-data sensitivity. (See the roadmap's HR lens.)

## 1. The key insight (why this is cheap and sticky here)

Two things mean we do **not** build a standalone HRIS:

1. **The employee record is an enrichment of the existing `User`+`OrgMember`** that already drives every module (assignments, time, billing, comms, compliance). So org chart, capacity, rates, and project membership are *one graph*, not a brittle HRIS↔PM sync.
2. **An "onboarding procedure" is literally a published template that provisions real work items.** Cosmos already has the `BoardTemplate`/`ProjectTemplate` **clone engine**, `WorkItem` hierarchy, and assignment/notification plumbing. An onboarding checklist is a template that, on hire, instantiates assigned `WorkItem`s with due dates — reusing infra that already works.

Switching cost compounds: ripping out Cosmos HR means re-wiring PM, time, finance, and compliance too.

## 2. Data model (new)

```prisma
model Employee {
  id            String   @id @default(cuid())
  orgId         String
  orgMemberId   String   @unique          // enriches the existing OrgMember
  employeeNo    String?
  title         String?
  departmentId  String?
  managerId     String?                    // -> Employee.id (org chart)
  startDate     DateTime?
  endDate       DateTime?
  employmentType String?                   // FULL_TIME|PART_TIME|CONTRACTOR|INTERN
  status        String   @default("ACTIVE") // ACTIVE|ONBOARDING|OFFBOARDING|TERMINATED
  // sensitive PII gated behind ABAC (see §5)
  customFields  Json?
  manager       Employee?  @relation("Reports", fields: [managerId], references: [id])
  reports       Employee[] @relation("Reports")
  onboardings   OnboardingRun[]
  @@unique([orgId, orgMemberId])
  @@index([orgId, departmentId])
}

model Department {
  id        String  @id @default(cuid())
  orgId     String
  name      String
  parentId  String?            // nested departments / org units
  leadId    String?            // -> Employee.id
  @@unique([orgId, name])
}

model OnboardingTemplate {
  id          String   @id @default(cuid())
  orgId       String
  name        String              // "Engineering new hire", "Sales onboarding", "Cleared-facility in-processing"
  description String?
  role        String?             // optional target work-role/title
  sector      String?             // reuse the sector taxonomy
  // ordered tasks; each can target an assignee role and an offset due date
  tasks       Json                // OnboardingTaskDef[]
  isBuiltIn   Boolean  @default(false)
  isPublished Boolean  @default(false)   // shareable in the org/cross-org template library
  createdById String
  @@unique([orgId, name])
}

model OnboardingRun {
  id            String   @id @default(cuid())
  orgId         String
  employeeId    String
  templateId    String
  status        String   @default("IN_PROGRESS") // IN_PROGRESS|COMPLETE|CANCELLED
  startedAt     DateTime @default(now())
  completedAt   DateTime?
  // materialized tasks become real WorkItems (or OnboardingTask rows) linked here
  @@index([orgId, employeeId])
}
```
```ts
type OnboardingTaskDef = {
  title: string;
  description?: string;
  // who does it: the new hire, their manager, IT, HR, a specific work-role
  assigneeRole: "new_hire" | "manager" | "it" | "hr" | "buddy";
  dueOffsetDays: number;          // relative to start date (e.g. -3 = pre-start, 1 = day one)
  // optional: provision access, require a doc acknowledgment, link a training/cert
  action?: { type: "doc_ack" | "grant_access" | "training" | "task"; ref?: string };
};
```

## 3. The flow

1. **HR authors a template** (Settings → People → Onboarding templates): ordered tasks with assignee-role + due-offset. Reuses the same authoring affordances as board/project templates; an onboarding template *is* a kind of work template (ties into the explicit "shareable workflow templates" ask).
2. **On hire** (manual "Start onboarding," or auto when an `Employee` is created — incl. via SCIM inbound later): pick a template → **`OnboardingRun`** materializes each `OnboardingTaskDef` into an assigned `WorkItem` (or `OnboardingTask`) with a computed due date (`startDate + dueOffsetDays`) and routed to the right person (new hire / manager / IT / HR) by **work-role** (the ABAC engine resolves "the new hire's manager," "an IT admin," etc.).
3. **Progress** shows on the employee's profile + a manager/HR dashboard; the scheduler substrate nudges overdue tasks.
4. **AI**: `generate_onboarding_plan(role, sector)` drafts a role/sector-specific template; AI can also summarize "where is each new hire stuck?"

## 4. Reuse, not rebuild

| Need | Reuse |
|---|---|
| Author + share templates | `BoardTemplate`/`ProjectTemplate` publish + clone engine + the cross-org Template Library (roadmap) |
| Tasks with assignees/due dates | `WorkItem` hierarchy + assignment + `Notification` |
| Document acknowledgment / offer letters | the `Contract` **DocuSign + PDF** envelope flow (one abstraction, HR supplies a template) |
| Training/cert links | the later Training module (`docs` TBD); cert expiry → `ComplianceControl` for a CMMC/NIST training-record story |
| Reminders / overdue nudges | the **scheduler substrate** (`docs/design/background-scheduler-substrate.md`) |
| "Who is the manager / IT?" routing | the **ABAC work-role engine** |

## 5. Sensitivity / access (why ABAC is a dependency)

Employee PII (comp, personal data, status) must be visible to HR + the person's manager but not peers. This is exactly an **ABAC** policy on the `Employee`/`OnboardingRun` resources (`when: same_department`/`is_manager_of`, `who: work-role hr`). **Do not hardcode "is HR" checks here** — they belong in the one engine so Finance/A&E inherit the same model. Hence ABAC sequences **before** HR.

## 6. Risks & sequencing

| Risk | Mitigation |
|---|---|
| PII exposure | ABAC-gated reads; PII fields excluded from default selects (same discipline as `OrgMember.permissions` JSON-serialization rule); audit access. |
| Scope creep into full HRIS | v1 = Employee + Department + org chart + onboarding templates/runs only. PTO, performance, ATS, payroll are **later** docs. |
| Template ↔ WorkItem coupling | Materialize tasks as normal `WorkItem`s so the rest of the product (boards, notifications, AI) "just works." |

**Rollout:** (1) ABAC engine (prereq). (2) `Employee`+`Department` + org-chart view (enrich `OrgMember`; no disruption to existing roles). (3) `OnboardingTemplate`+`OnboardingRun` + the on-hire materializer + HR authoring UI. (4) Scheduler-driven reminders. (5) Offer-letter/doc-ack via DocuSign reuse. (6) Training/certs + skills (later).

**Open questions for sign-off:** (a) materialize onboarding tasks as `WorkItem`s vs a dedicated `OnboardingTask` table; (b) auto-start onboarding on `Employee` create vs manual; (c) how much PII lands in v1 (and its retention policy); (d) confirm Employee enriches `OrgMember` 1:1 (vs supporting non-user contractors without an `OrgMember`).
