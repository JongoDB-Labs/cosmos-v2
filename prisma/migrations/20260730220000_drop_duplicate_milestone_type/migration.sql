-- Drop the duplicate "Milestone" work-item type.
--
-- `consulting.milestone_item` and `cross.milestone` are both seeded with name
-- "Milestone" and pluralName "Milestones". Create pickers hid the consulting
-- one, but the Issues TYPE FILTER reads every seeded type, so an org saw two
-- identical "Milestone" options — and picking the wrong one matched nothing,
-- because no work item has ever carried it (0 rows on production).
--
-- It is no longer seeded (prisma/seed/sectors/consulting.ts), so this removes
-- the rows already created for existing orgs.
--
-- GUARDED, deliberately: the delete only touches a type that NOTHING references.
-- If any org ever did type an item `consulting.milestone_item`, this migration
-- leaves that row alone rather than orphaning or retyping their work — the
-- duplicate stays visible for them and we fix it as a data question, which is
-- the safe failure. Verified on production before writing this: 13 items on
-- `cross.milestone`, 0 on `consulting.milestone_item`.
DELETE FROM "work_item_types" wit
 WHERE wit."key" = 'consulting.milestone_item'
   AND NOT EXISTS (
     SELECT 1 FROM "work_items" wi WHERE wi."work_item_type_id" = wit."id"
   );
