# Design: Work-Role ABAC Engine

> **Status:** ✅ **Core engine shipped** (v3.26.0 → v3.36.x; PRs #42/#43/#57/#58/#59) — this documents it **as built**. The remaining unbuilt piece is the AI NL policy authoring + simulation in §5. · **Authored:** 2026-06-02 · **Updated:** 2026-06-03
> **Spine item.** The cross-cutting policy engine the HR, Finance, and A&E lenses inherit instead of reinventing approval/sensitivity logic. (See `docs/roadmap/cosmos-ai-first-roadmap.md`.)

## 1. Problem

Before this engine, access control was **role-bitfield only** (the bitfield is still the fast base layer — ABAC now augments it):

- `Permission` is a bitfield of 77 named capabilities (`src/lib/rbac/permissions.ts`).
- `RolePermissions` maps each `OrgRole` (OWNER/ADMIN/BILLING_ADMIN/MEMBER/VIEWER/GUEST) to a combined bitmask.
- `resolvePermissions(orgRole, storedPermissions)` = role base mask `|` the per-member `OrgMember.permissions` (BigInt) override.
- **`requirePermission(ctx, required)`** (`src/lib/rbac/check.ts`) is the single chokepoint every route calls.

What it lacked — **now built by this engine**:
- **No work-role layer.** A "manager", "HR coordinator", "IT/sysadmin", "team lead", "finance approver", "ISSO" were not modeled. Org roles are coarse (ADMIN vs MEMBER); they can't express "managers can approve expenses for their own team" or "HR can see PII; engineers can't." → solved by `WorkRole` (§3a).
- **No attribute/context conditions.** Permissions were global per member — they couldn't depend on the *resource* (its project, owner, amount) or the *relationship* (does the actor own it?). → solved by the rule grammar (§3b).
- **`OrgMember.abacRules` (JSON)** was scaffolded but dormant. It is now the per-member rule store — loaded by `loadEffectivePermissions` and evaluated by `requireAccess` (`src/lib/rbac/require-access.ts`), alongside `WorkRole.policies`.

Without this, every upcoming lens reinvents role logic: HR will hardcode "is manager" checks, Finance will hardcode "approver" checks, A&E will hardcode "reviewer" checks — divergent, untestable, and impossible to audit centrally.

## 2. Goals / non-goals

**Goals**
- A **work-role** concept layered on top of org roles, assignable per member, mapping to permission grants + ABAC policies.
- **Attribute-based conditions** evaluated at the existing `requirePermission` chokepoint: deny/allow based on resource attributes (project, owner, classification, amount, status) and actor attributes (their work-roles, their managed team, their department).
- **One policy decision point** that HR/Finance/A&E approvals inherit — no per-module role logic.
- **AI-authored policies**: describe a rule in natural language → generate the rule JSON → **simulate its impact** against current members/resources before saving.
- **Auditable**: every allow/deny decision that matters is explainable and logged.

**Non-goals (v1)**
- Not replacing the bitfield — ABAC *augments* it (bitfield stays the fast base check).
- Not a general-purpose policy language (no Rego/OPA dependency); a small, typed, JSON rule grammar.
- Not row-level Postgres RLS (evaluation stays in app code at the chokepoint).

## 3. Data model (no migration for the rule store — `abacRules` already exists)

Two pieces:

### 3a. Work roles (new, additive)
```prisma
model WorkRole {
  id          String   @id @default(cuid())
  orgId       String
  key         String   // "manager", "hr", "it_admin", "finance_approver", "team_lead", "isso"
  name        String
  description String?
  // Permission bits this work-role grants ON TOP of the org role.
  grants      BigInt   @default(0)
  // ABAC policies (see grammar below) attached to this work-role.
  policies    Json     @default("[]")
  isBuiltIn   Boolean  @default(false)
  createdAt   DateTime @default(now())
  org         Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  members     OrgMemberWorkRole[]
  @@unique([orgId, key])
}

model OrgMemberWorkRole {
  orgMemberId String
  workRoleId  String
  // optional attribute scoping for THIS assignment, e.g. { projectIds: [...], departmentId: "..." }
  scope       Json?
  @@id([orgMemberId, workRoleId])
}
```
> This is the additive migration. The **per-member `abacRules` JSON field is reused as-is** for member-specific overrides; work-role policies live on `WorkRole.policies`.

### 3b. Rule grammar (typed JSON — stored in `WorkRole.policies` / `OrgMember.abacRules`)

The shipped grammar (`src/lib/abac/engine.ts`) is **flat**: a rule lists the `actions` it governs and one `conditions` array (logical AND). Resource attributes aren't nested in the rule — the calling route passes them to `evaluateAccess()` as `ResourceAttributes`.
```ts
type AbacRule = {
  id?: string;
  effect: "allow" | "deny";          // v1 ENFORCES deny only — see note
  actions: PermissionKey[];          // capabilities this rule governs (non-empty to apply)
  conditions: AbacCondition[];       // ALL must hold for the rule to fire (empty = unconditional)
};
type AbacCondition =
  | { attr: string;
      op: "eq" | "ne" | "in" | "nin" | "gt" | "gte" | "lt" | "lte" | "contains";
      value: string | number | boolean | Array<string | number> }
  // relationship predicates resolved by the engine / caller:
  | { rel: "owns_resource" | "in_project" | "is_manager_of_assignee" | "same_department" };
```
> **Deny-only in v1.** The `effect` type carries `allow|deny`, but the engine computes **`RBAC-baseline AND NOT(any firing deny)`** — an `allow` rule is **inert** (reserved for a future additive-allow mode), which removes the "authoring an allow silently revokes the baseline" footgun. Denies **fail closed**: a condition over a missing attribute / unresolved relationship leaves the deny firing. Of the relationship predicates, `owns_resource` is computed purely (resource owner vs. actor `User.id`) and `in_project` is supplied by the route; `is_manager_of_assignee`/`same_department` exist in the type but require caller-side resolution and aren't wired yet. **Authoring** (`workRolePolicySchema`, the Settings editor) is restricted to `deny` rules using `owns_resource`/`in_project`.

Example — "this work-role may approve expenses, but NOT any over $5k":
```json
{ "effect": "deny", "actions": ["EXPENSE_APPROVE"],
  "conditions": [{ "attr": "amount", "op": "gt", "value": 5000 }] }
```
(see `src/lib/abac/engine.test.ts` for worked `owns_resource` / `in_project` examples.)

## 4. Evaluation (slots into the existing chokepoint)

Add `requireAccess(ctx, action, resource?)` alongside `requirePermission`:

```
1. Base bitfield gate (unchanged, fast):
   if !hasPermission(ctx.permissions, Permission[action]) → DENY (unless a work-role grant adds it).
2. Collect applicable ABAC rules:
   member.abacRules ++ each assigned WorkRole.policies (scoped by assignment.scope).
3. Evaluate (v1 = **deny-only**): result is `RBAC-baseline AND NOT(any firing deny)`. `allow` rules are **inert** (reserved for a future additive-allow mode). A deny **fails closed** — a condition over a missing attribute / unresolved relationship leaves the deny firing.
   If no deny references this action → fall through to step 1's result (backwards compatible).
4. Relationship predicates (is_manager_of_assignee, etc.) resolved via cheap indexed queries,
   memoized per request.
```

**Order & compatibility:** ABAC is **additive and opt-in per action**. If an org defines no work-roles/policies, behavior is **identical to today** (step 1 only). This makes rollout safe — nothing changes until an org authors a policy.

**Where it's called:** `requireAccess` replaces `requirePermission` only in routes where resource-aware decisions matter (expense/invoice approval, HR PII reads, A&E deliverable sign-off, work-item edit-if-assignee). Everywhere else keeps the cheap `requirePermission`.

## 5. AI policy authoring + simulation (the differentiator)

> ⏳ **Not yet built.** The manual deny-policy editor shipped (Settings → Roles & Access, #59); the NL authoring + pre-save simulation below remain planned.

- **Author:** an executor `draft_abac_policy(nl)` turns "managers can approve expenses under $5k for their reports" into the rule JSON above (it knows the `Permission` keys + resource types from the registry).
- **Simulate before save:** `simulate_policy(rule)` runs the rule against a sample of current members × recent resources and reports "this would newly ALLOW 4 members to approve 23 expenses; newly DENY 1 member from X" — so an admin sees impact before committing. No incumbent IGA tool offers NL-authored, pre-validated policies.
- All authoring/simulation reuses the existing Claude executor + RBAC-gated tool pattern.

## 6. Surfaces

- **Settings → Roles & Access** (✅ shipped, #43/#59): CRUD work-roles, assign to members, and a deny-policy editor (action checklist + `owns_resource`/`in_project` condition rows). The NL author + simulate panel (§5) is the remaining planned addition.
- Member table (`/team`) gains a work-role column + assignment control.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| ABAC makes hot paths slow | Bitfield stays the first gate; ABAC only evaluated for actions that have rules; relationship queries memoized per request; rule sets are tiny. |
| A bad `deny` locks people out | OWNER is always exempt from ABAC deny (break-glass); simulate-before-save; full audit of denials. |
| Policy logic drift vs the bitfield | One engine, one `requireAccess`; rules reference `Permission` keys so they can't grant unknown capabilities. |
| Cross-tenant leakage | Work-roles + rules are org-scoped; relationship predicates always filter by `ctx.orgId`. |

## 8. Rollout / sequencing

1. ✅ Shipped `WorkRole` + `OrgMemberWorkRole` migration + the evaluator (#42) — no behavior change until an org authors a policy.
2. ✅ Work-role CRUD + per-member assignment + the deny-policy authoring editor (#43/#59), with the **grant-ceiling invariant**: authoring/assigning is bounded by `basePermissions` (role base | override, EXCLUDING work-role grants) to prevent self-grant laundering.
3. ✅ Converted ~16 resource-mutation routes to `requireAccess` (#57/#58): notes, CRM, finance (expense/revenue + submit), time entries, meetings, objectives, key-results, work-items, comments, analytics, feedback.
4. ⏳ Next: HR / Finance / A&E approval features build on `requireAccess`; per-sector built-in work-role templates; the §5 AI authoring/simulation.

**Resolved in the build:** the v1 **deny-only** grammar shipped as in §3b; ~16 routes converted to `requireAccess` (#58). **Still open:** per-sector built-in work-role templates; whether to add an additive-allow mode; the §5 AI authoring/simulation.
