# Access-control audit — tenant, org, project, "team"

**Date:** 2026-07-29 · **Task:** #34 · **Status:** findings only — no permission changes made

Ground truth for what is *actually enforced* before team-scoped access is designed (#35, #36).
Driving use case throughout: **a subcontractor who must see only their own team's work.**

Every claim below cites `file:line`. Claims are split into **Enforced** (server-side, verified) and
**Not enforced** (absent, decorative, or UI-only).

---

## TL;DR

1. **There is no team concept in core at all.** No `Team` model exists in `prisma/schema.prisma`.
2. **`ProjectMember` is a roster, not an access boundary.** Read access is decided entirely by
   org-level permission bits. Being a member of a project neither grants nor restricts reads.
3. **The subcontractor use case is not achievable today** without authoring an ABAC deny policy —
   and even then there is a hole (finding 5) that makes it bypassable by URL.
4. **`ProjectRole.LEAD` / `MEMBER` / `VIEWER` are decorative.** Only `MANAGER` is ever consulted.

---

## 1. The permission model that *is* enforced

Org role → permission bitmask, resolved at session time and carried on `AuthContext`.

- `AuthContext` carries `permissions`, `basePermissions`, `abacRules` — `src/lib/rbac/check.ts:5-18`
- `requirePermission` is a pure bitmask test. **It does not consult ABAC** —
  `src/lib/rbac/check.ts:29-36`
- Role → bit defaults — `src/lib/rbac/permissions.ts:165`
- The bitmask is a decimal **string** in a TEXT column because bits ≥ 63 overflow Postgres BIGINT —
  `prisma/schema.prisma:409` (`OrgMember.permissions`). Cross the boundary via
  `maskFromDb()`/`maskToDb()`; never serialize raw.

**Defaults that matter for the driving use case** (`src/lib/rbac/permissions.ts:264-325`):

| Org role | Gets `PROJECT_READ` | Gets `BOARD_READ` | Gets `ITEM_READ` |
|---|---|---|---|
| OWNER | ✓ (all bits) | ✓ | ✓ |
| ADMIN | ✓ | ✓ | ✓ |
| MEMBER | ✓ | ✓ | ✓ |
| VIEWER | ✓ | ✓ | ✓ |
| GUEST | ✗ | ✗ | ✓ |

These bits are **org-wide**. There is no per-project variant of any read bit.

> **GUEST is an odd shape worth a decision:** it holds `ITEM_READ` without `PROJECT_READ` or
> `BOARD_READ` (`permissions.ts:321-325`). Since item routes gate on `ITEM_READ` alone (finding 5),
> a GUEST can read work items across every project while being unable to list the projects those
> items belong to. Not obviously intended.

---

## 2. Enforced: the org → project admin boundary

`canManageProject` — `src/lib/rbac/scope.ts:14-33`. True when the actor either holds org-wide
`PROJECT_MANAGE`, **or** is a `ProjectMember` with `role = MANAGER` on that exact project. Set form
for list views: `getManagedProjectIds` — `scope.ts:42-64`.

This is real, server-side, and correct. It is also **the only place `ProjectMember` affects
authorization.**

---

## 3. Not enforced: `ProjectMember` as a read boundary

`ProjectMember` — `prisma/schema.prisma:648`. It carries staffing/compliance attributes
(`allocationPercent`, `onContract`, `cacStatus`, `ndaStatus`, …) and a `role`.

**Only 3 non-test API route files out of 339 reference it at all**, and all three are
membership/staffing CRUD rather than access checks:

```
src/app/api/v1/orgs/[orgId]/projects/route.ts
src/app/api/v1/orgs/[orgId]/projects/[projectId]/members/route.ts
src/app/api/v1/orgs/[orgId]/projects/[projectId]/staffing/[memberId]/route.ts
```

**The project list returns every project in the org**, gated only on the org-wide bit —
`src/app/api/v1/orgs/[orgId]/projects/route.ts:39-49`:

```ts
requirePermission(ctx, Permission.PROJECT_READ);
const projects = await prisma.project.findMany({
  where: { orgId, archived },      // no ProjectMember filter
```

> **Consequence for the driving use case:** a subcontractor invited as a plain `MEMBER` sees
> *every project in the org*, whether or not they are a `ProjectMember` of any of them.

### 3a. `ProjectRole` is decorative below MANAGER

`ProjectRole` has four values — `prisma/schema.prisma:35-40`. Across all of `src/`, outside tests,
`ProjectRole` appears in **exactly two places**, both `MANAGER`, both in `scope.ts:29,58`.

`LEAD`, `MEMBER` and `VIEWER` are stored and displayed but grant and restrict nothing. Anyone
reading the members UI would reasonably assume otherwise — this is the most likely source of a false
sense of containment.

---

## 4. Enforced: ABAC, where it is wired up

The engine is sound and deliberately fails closed.

- `requireAccess` — `src/lib/abac/require-access.ts:20-65`. Resolves only the predicates the relevant
  rules actually use, then defers to the pure `evaluateAccess`.
- Behaviour is **identical to `requirePermission` until an org authors a policy**
  (`require-access.ts:16-18`) — so adoption on a route is safe pre-policy.
- `in_project` resolves `userId → OrgMember.id → ProjectMember` — `require-access.ts:73-88`.
- Unresolvable predicates fail a DENY **closed** — `require-access.ts:43-52`. `is_manager_of_assignee`
  and `same_department` have no backing data and stay permanently unresolved.

**Cross-project list narrowing** is real and well-built: `getReadableProjectIds` —
`src/lib/work-items/query/scope.ts`. It folds the per-project `in_project` deny into a single
resolved project-id set, with an OWNER break-glass, and hard-scopes the query to that set. Used by
the four org-wide surfaces:

```
work-items/search/route.ts   work-items/facets/route.ts
work-items/[itemId]/row/route.ts   activity/route.ts
```

Note its own stated contract: *"With no policies (the common case) this is every project."*
Narrowing exists **only** if an org has authored an ABAC deny.

---

## 5. ⚠️ Finding: the `in_project` deny is bypassable on the project's own board

This is the most consequential finding, because it undermines the *only* mechanism that can express
"see only your team's work" today.

| Surface | Gate used | `in_project` deny honoured? |
|---|---|---|
| Org-wide Issues search | raw bit + `getReadableProjectIds` | **Yes** |
| Issues facets / activity / row | raw bit + `getReadableProjectIds` | **Yes** |
| Project work-items **GET** | `requirePermission(ITEM_READ)` only | **No** |
| Project work-items **POST** | `requireAccess("ITEM_CREATE", { projectId })` | Yes |

Evidence — `src/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route.ts`:

```ts
// GET, line 56
requirePermission(ctx, Permission.ITEM_READ);        // raw bitmask, no ABAC
...
// line 62
const where: Record<string, unknown> = { orgId, projectId };   // no membership scoping
```

versus the POST in the same file, line 120, which *does* go through ABAC:

```ts
await requireAccess(ctx, "ITEM_CREATE", { orgId, projectId, ... });
```

`requirePermission` does not consult `ctx.abacRules` at all (`check.ts:29-36`), so an
`in_project` DENY on `ITEM_READ` is enforced on the org-wide Issues list and silently ignored by the
project board endpoint. An actor denied a project in search can still read its items by requesting
that project's work-items URL directly.

**Severity:** high *if any org has authored such a policy*; latent otherwise. Worth confirming
whether any org has, before deciding urgency.

**Deliberately not fixed here** — this audit changes nothing. Swapping the GET to `requireAccess`
looks like a one-line fix, which is exactly the kind of plausible access-control change that should
be made with tests and intent rather than in passing.

---

## 6. Not present: teams

There is **no `Team` model in core** — no match for `model .*Team` in `prisma/schema.prisma`.

The nearest things that exist:

- **`OrgMemberWorkRole`** (`schema.prisma:2811`) + `src/lib/rbac/work-role.ts` — work-roles carry
  extra permission grants and ABAC policies on top of the base org role, validated against the
  actor's own ceiling so a self-granted permission can't be laundered into a new role
  (`check.ts:10-14`). This is the closest existing primitive to "a group with a policy," and is the
  natural attachment point for team-scoped rules.
- **`PiPlanningTeam`** — lives in the PI Planning plugin, *not* core. Per the #35 decision the plugin
  must not own teams; its "Teams & Roles" surface becomes a mapping onto core teams.

> **Audit note relevant to #35:** because `ProjectMember` currently carries no access meaning, a
> plugin-owned team table that *did* gate access would not be "a second unaudited path" so much as
> **the only** path — there is no core mechanism for it to duplicate yet. The risk flagged in #35 is
> real but arrives with the plugin, not before it.

---

## 7. Multi-tenancy (the layer that *is* solid)

Tenant isolation is consistently enforced and is not the weak point. Routes resolve the org first,
build `AuthContext` from `getAuthContext(org.slug)`, and carry `orgId` into every query's `where`
(e.g. `work-items/route.ts:58,62`). Project lookups are `findFirst({ where: { id: projectId, orgId } })`,
so a cross-tenant projectId 404s rather than leaking.

---

## Recommendations (for #35 / #36 — not applied)

1. **Decide the read model explicitly.** Today: *org-wide read, project-scoped admin*. The
   subcontractor case needs *project/team-scoped read*. That is a change of default posture, not a
   new flag — it should be a written decision before any code.
2. **Close finding 5 first, with a regression test.** Any team feature layered on ABAC inherits this
   hole; fixing it afterwards means auditing twice.
3. **Give `ProjectRole.LEAD`/`MEMBER`/`VIEWER` meaning or remove them.** A role enum that looks
   enforced and isn't is worse than no enum.
4. **Prefer extending work-roles over inventing a parallel team-permission path** — the ceiling
   validation and ABAC plumbing already exist and are tested.
5. **Resolve GUEST's `ITEM_READ`-without-`PROJECT_READ` shape** as part of the same decision.
