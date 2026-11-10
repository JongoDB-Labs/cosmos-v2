# Register consolidation: PM registers become work items

Status: accepted 2026-11-10. Supersedes nothing; builds on 2.544.0 (Issues →
Work Items, PM Dashboard → Program Management).

## Problem

Program management lives in six parallel registers — change requests, CLINs,
KPIs, deliverables, milestones, risks — each with its own table, REST routes,
AI executor, importer, exporter and dashboard panel. Every cross-cutting feature
(search, CQL, boards, watchers, comments, links, notifications, permissions,
audit) has to be rebuilt per register or is simply missing from it. Work items
already have all of it.

## Decisions (made by the product owner; not reopened here)

1. A register record **is a work item** of a built-in type.
2. Money and dates live in **typed satellite tables**, 1:1 with the work item.
   `customFields` JSON is only for genuinely free-form fields. Typed columns
   stay queryable, validated, and gateable by permission (finance fields
   especially).
3. Order: **change requests → CLINs → KPIs → deliverables → milestones →
   risks**. Risks last: they overlap the RAID log.
4. PM **vendors are Partner records**, not a new type.
5. Status keys use **one spelling**: `in-progress` (the spelling the seeds and
   built-in templates already use, and most existing rows).
6. Program Calendar stays a retired module until it moves into Program
   Management.

## Target shape (per register)

| Concern | Where it lives |
|---|---|
| Identity, title, description, project, assignees, watchers, comments, links, labels, activity, search | `work_items` (unchanged) |
| Which register | a built-in `work_item_types` row, e.g. key `change_request` |
| Lifecycle | the type's **workflow** (per-project `workflow_assignments` for that type) |
| Typed register fields (money, dates, contract references, classification) | satellite table, `work_item_id uuid UNIQUE NOT NULL REFERENCES work_items ON DELETE CASCADE` |
| Free-form extras | `work_items.custom_fields` |

The satellite keeps the existing table (e.g. `change_requests`) rather than a
new one: its typed columns, indexes and grants already exist, and existing
readers can be moved one at a time.

### Lifecycle carries the decision

A register's decision (approved, rejected, …) is its **status**, not a second
field. Built-in workflows create statuses with fixed keys, and a status key is
immutable in the UI (renames cascade), so semantics may key off them safely.
For change requests:

| key | category | means |
|---|---|---|
| `cr-submitted` | TODO | awaiting review |
| `cr-under-review` | IN_PROGRESS | being assessed |
| `cr-approved` | IN_PROGRESS | approved, not yet implemented |
| `cr-implemented` | DONE | approved and in effect |
| `cr-rejected` | CANCELLED | refused |
| `cr-withdrawn` | CANCELLED | withdrawn by the initiator |

"Approved cost" = `cost_impact` of items in `cr-approved` or `cr-implemented`.
A separate `decision` column was rejected: boards move work items through the
generic status path, which would leave it stale — a correct rule with one call
site.

### Money stays gated

Typed money columns are only selected when the caller holds `FINANCE_READ` or
`ACCOUNTING_READ` — on every read path (REST, AI executors, export,
dashboards), not just the Program Management page. The per-project PM
dashboard and the CLIN route currently show money to `ANALYTICS_READ` alone;
moving them onto the shared service closes that.

## Change requests: the first slice

1. **Link.** Add `change_requests.work_item_id` (nullable, unique). Migration
   creates the built-in `change_request` type and Change Control workflow for
   each org that has change requests, assigns it in each such project, and for
   every existing row creates a work item (title, description, project, status
   mapped from `ChangeRequestStatus` to the keys above), then links it. A
   migration test applies the real SQL in a rolled-back transaction, as
   `purge_orphan_work_items` does.
2. **One service.** `src/lib/registers/change-requests.ts` creates, updates,
   lists and deletes a change request as work item + satellite in one
   transaction, with the money gate inside it. The REST routes under
   `/projects/:id/changes` keep their response shape and call it; the AI
   executor, importer and exporter move onto it.
3. **UI.** Change requests appear in Work Items, boards and search by type. The
   change tracker and Program Management read through the service. The work
   item detail shows the typed fields for its type.
4. **Contract.** `work_item_id` becomes NOT NULL; the duplicated columns
   (`title`, `description`, `status`, `project_id`) are dropped. Schema-breaking,
   so a **major** version.

Each step ships on its own, with localhost end-to-end checks on the change
tracker, the Work Items list filtered to the type, and Program Management.

## The rest, in order

The same four steps for CLINs (money: ceiling, funded, billed), KPIs, deliverables,
milestones, risks. Vendors fold into Partner. The `in_progress` → `in-progress`
status normalization is independent and small, so it can ship at any point;
where a project holds both keys, the migration merges them into one status
rather than renaming into a unique-key collision.

## Not in scope

Per-register dashboards are not rebuilt here; they read through the new
services until Program Management replaces them.
