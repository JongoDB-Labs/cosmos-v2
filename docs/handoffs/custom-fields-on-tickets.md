# Handoff: Custom fields on tickets + filterable

**Prod feedback FR** "issue/ticket fields": "Someone (admin/owner) should be able to add fields to their project scope that can be used on tickets. So if I wanted to add a 'goal' field, that should be doable, and then I should be able to filter/query on that just like I can on sprint/etc."

Read `docs/handoffs/README.md` first for shared context.

## Current state (the gap)
- **Definition layer EXISTS:** `CustomField` Prisma model (org+project scoped: `id, orgId, projectId?, name, key, fieldType (FieldType enum), options Json, required, sortOrder`, `typeBindings WorkItemTypeField[]`, `@@unique([orgId,key])`). Settings UI `src/components/settings/custom-fields-manager.tsx` does full CRUD on field defs. `WorkItem.customFields` is a `Json` column already storing per-item values.
- **The gap:** NO work-item component renders these defined fields (`grep -rln customField src/components/work-items` → nothing). So a defined field never appears on the create dialog or detail sheet, values aren't editable, and you can't filter by them.

## Build
1. **Fetch the project's custom-field defs** where they're needed. Likely a small hook `useCustomFields(orgId, projectId)` over the existing custom-fields API (find it under `src/app/api/v1/orgs/[orgId]/.../custom-fields` or similar; the manager already calls it).
2. **Render on create + detail:**
   - `src/components/work-items/create-work-item-dialog.tsx` — after the built-in fields, render an input per custom-field def (TEXT/NUMBER/DATE/SELECT[options]/CHECKBOX per `fieldType`), writing into the POST body's `customFields` object keyed by `field.key`. Respect `required`.
   - `src/components/work-items/card-detail-sheet.tsx` — render the same, reading/writing `item.customFields[field.key]` via the existing single-field PUT (`patchField`-style). Honor `WorkItemTypeField` bindings if a field is bound to specific work-item types.
3. **Filter/query:** add custom fields to the board filter (`src/components/boards/shared/filter-bar.tsx` + the work-items list query). The work-items API filters by built-ins today (search/type/priority/assignee/cycle); extend the `where` to match `customFields` JSON keys (Prisma `path`-based JSON filtering on the `customFields` column). Surface a filter control per filterable field (start with SELECT/CHECKBOX/TEXT-equals).
4. **No schema migration likely needed** — `CustomField` + `WorkItem.customFields` already exist. Only add columns if you introduce a "filterable"/"showOnCard" flag on `CustomField` (additive nullable if so).

## Acceptance
- Admin defines a field (e.g. "Goal", TEXT) in Settings → it appears on the create dialog + detail sheet for that project's items, persists in `customFields`, and round-trips on reload.
- A SELECT/CHECKBOX field is filterable from the board filter bar (filtering narrows the visible items).
- Verified via Playwright (`localhost`): define field → create item with it → reload shows value → filter by it.
- Deployed, prod healthy, feedback item DONE, log updated.

## Watch out
- base-ui Select `onValueChange` is `(string|null)`; `value=""` is "unset" (use a sentinel) — or reuse the shared `SearchableSelect`/`Select` wrappers. JSON filtering: confirm the Prisma version's JSON path filter syntax against `node_modules/.prisma` / the Prisma docs. Keep `customFields` projections out of any `success()` that would break on non-serializable values (it's plain JSON, so fine).
