-- Deleting an organization must actually delete that organization's rows.
--
-- 48 tables carried a bare `org_id` with NO foreign key to `organizations`, so
-- `DELETE FROM organizations` left every one of their rows behind: work items,
-- boards, comments, notes, time entries, invoices, payroll, contracts. The rows
-- were unreachable through the app (every query is org-scoped) but still in the
-- database -- a tenant "delete" that did not delete the tenant's data.
--
-- Every table that already had the relation was correct (onDelete: Cascade, none
-- misconfigured), so this only adds what was missing.
--
-- `audit_logs` is deliberately EXCLUDED and keeps its FK-less `org_id`: it is the
-- tombstone that must SURVIVE the cascade, as the delete handler documents.
--
-- STEP 1 removes rows orphaned by PAST deletions. Without it, ADD CONSTRAINT fails
-- on any database where an org was ever deleted -- the constraint cannot be created
-- while violating rows exist. Rows whose org_id IS NULL are global/built-in records
-- (board templates, themes) and are preserved.

-- STEP 1: clear pre-existing orphans so the constraints can be created.

DELETE FROM "accounting_periods" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "accounting_periods"."org_id");
DELETE FROM "accounts" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "accounts"."org_id");
DELETE FROM "activities" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "activities"."org_id");
DELETE FROM "bank_accounts" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "bank_accounts"."org_id");
DELETE FROM "bank_rules" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "bank_rules"."org_id");
DELETE FROM "bank_transactions" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "bank_transactions"."org_id");
DELETE FROM "board_templates" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "board_templates"."org_id");
DELETE FROM "boards" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "boards"."org_id");
DELETE FROM "clins" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "clins"."org_id");
DELETE FROM "comments" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "comments"."org_id");
DELETE FROM "contracts" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "contracts"."org_id");
DELETE FROM "crm_contacts" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "crm_contacts"."org_id");
DELETE FROM "custom_fields" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "custom_fields"."org_id");
DELETE FROM "document_blocks" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "document_blocks"."org_id");
DELETE FROM "document_item_links" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "document_item_links"."org_id");
DELETE FROM "employee_cost_rates" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "employee_cost_rates"."org_id");
DELETE FROM "employee_supervisors" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "employee_supervisors"."org_id");
DELETE FROM "employees" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "employees"."org_id");
DELETE FROM "entity_references" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "entity_references"."org_id");
DELETE FROM "expenses" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "expenses"."org_id");
DELETE FROM "feedback_attachments" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "feedback_attachments"."org_id");
DELETE FROM "frozen_orgs" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "frozen_orgs"."org_id");
DELETE FROM "invoices" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "invoices"."org_id");
DELETE FROM "journal_entries" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "journal_entries"."org_id");
DELETE FROM "journal_lines" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "journal_lines"."org_id");
DELETE FROM "key_result_links" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "key_result_links"."org_id");
DELETE FROM "notes" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "notes"."org_id");
DELETE FROM "notifications" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "notifications"."org_id");
DELETE FROM "objective_links" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "objective_links"."org_id");
DELETE FROM "partners" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "partners"."org_id");
DELETE FROM "pay_runs" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "pay_runs"."org_id");
DELETE FROM "payments" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "payments"."org_id");
DELETE FROM "pm_links" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "pm_links"."org_id");
DELETE FROM "products" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "products"."org_id");
DELETE FROM "revenues" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "revenues"."org_id");
DELETE FROM "sprint_ceremonies" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "sprint_ceremonies"."org_id");
DELETE FROM "supervisor_requests" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "supervisor_requests"."org_id");
DELETE FROM "sync_meetings" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "sync_meetings"."org_id");
DELETE FROM "tax_rates" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "tax_rates"."org_id");
DELETE FROM "themes" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "themes"."org_id");
DELETE FROM "time_entries" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "time_entries"."org_id");
DELETE FROM "time_entry_revisions" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "time_entry_revisions"."org_id");
DELETE FROM "timesheets" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "timesheets"."org_id");
DELETE FROM "work_item_attachments" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "work_item_attachments"."org_id");
DELETE FROM "work_item_labels" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "work_item_labels"."org_id");
DELETE FROM "work_item_links" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "work_item_links"."org_id");
DELETE FROM "work_item_watchers" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "work_item_watchers"."org_id");
DELETE FROM "work_items" WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = "work_items"."org_id");

-- STEP 2: add the missing cascading foreign keys.
ALTER TABLE "boards" ADD CONSTRAINT "boards_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_item_watchers" ADD CONSTRAINT "work_item_watchers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_item_labels" ADD CONSTRAINT "work_item_labels_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "activities_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notes" ADD CONSTRAINT "notes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partners" ADD CONSTRAINT "partners_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_templates" ADD CONSTRAINT "board_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sprint_ceremonies" ADD CONSTRAINT "sprint_ceremonies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "time_entry_revisions" ADD CONSTRAINT "time_entry_revisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "revenues" ADD CONSTRAINT "revenues_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sync_meetings" ADD CONSTRAINT "sync_meetings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "themes" ADD CONSTRAINT "themes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "frozen_orgs" ADD CONSTRAINT "frozen_orgs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "key_result_links" ADD CONSTRAINT "key_result_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "objective_links" ADD CONSTRAINT "objective_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "feedback_attachments" ADD CONSTRAINT "feedback_attachments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_item_links" ADD CONSTRAINT "work_item_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_item_attachments" ADD CONSTRAINT "work_item_attachments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employees" ADD CONSTRAINT "employees_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_cost_rates" ADD CONSTRAINT "employee_cost_rates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_supervisors" ADD CONSTRAINT "employee_supervisors_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supervisor_requests" ADD CONSTRAINT "supervisor_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_blocks" ADD CONSTRAINT "document_blocks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_item_links" ADD CONSTRAINT "document_item_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "clins" ADD CONSTRAINT "clins_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pm_links" ADD CONSTRAINT "pm_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "entity_references" ADD CONSTRAINT "entity_references_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
