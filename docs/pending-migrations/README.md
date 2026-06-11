# Pending migrations (need explicit authorization before applying to prod)

These are verified-but-unapplied migrations that transform **existing production
data** (not additive/safe), so they were intentionally NOT auto-applied during
the autonomous build. Apply each deliberately: **run the migration FIRST, then
deploy the matching app version** (the UI depends on the converted data).

---

## `20260611100000_crm_owner_id_to_user_id.sql`

**What it fixes:** the CRM Owner picker historically stored the `OrgMember`
membership-record id in `crm_contacts.owner_id`, but the ABAC engine's
`owns_resource` rule compares `ownerId` to the acting user's `User.id` — so
owner-scoped grants/denies on `CRM_UPDATE`/`CRM_DELETE` never matched the real
owner. This back-fills existing rows from `OrgMember.id` → that member's
`user_id`.

**Safety:** deterministic + idempotent. It only rewrites rows whose `owner_id`
currently equals an existing `org_members.id`; rows already holding a `user_id`
won't match (ids are distinct UUIDs) and NULLs are untouched. Verified on the
e2e test DB (convert + idempotent re-run + no-op on already-converted rows).

**Why it's parked:** transforming real CRM owner assignments is the one CRM fix
that needs a human go-ahead (the auto-mode classifier correctly gated it). The
sibling additive fix (contact email/phone/company/title columns) already shipped
in 2.77.2.

**Companion code (NOT yet in the tree — re-apply when you run this):**
- `src/components/crm/contact-detail-sheet.tsx`: Owner picker option value
  `m.id` → `m.userId`.
- `src/components/crm/contact-card.tsx`: owner lookup
  `members.find(m => m.id === contact.ownerId)` → `m.userId === contact.ownerId`.

**Apply order (must be migrate → deploy, or existing contacts show "Unassigned"
until re-saved):**
```bash
# 1. move this file into prisma/migrations/<same-name>/migration.sql, then:
sudo docker build --target migrate -t cosmos-v2-migrate:dev .
sudo docker compose run --rm cosmos-migrate      # applies the data conversion
# 2. re-apply the two component edits above, bump version, then:
sudo docker build -t cosmos-v2:dev .
sudo docker compose up -d --no-deps --force-recreate cosmos
```
