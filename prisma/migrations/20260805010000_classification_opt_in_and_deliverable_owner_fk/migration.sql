-- Classification becomes OPT-IN, and Deliverable gains a real owner FK.
--
-- WHY (classification): `classification` carried `@default(CUI)` on four PM
-- register models while no application code ever wrote the column. Every row of
-- every tenant was therefore silently stamped Controlled Unclassified
-- Information -- including commercial firms, which have no CUI authority at all
-- and for whom the marking is simply wrong. Classification is a GOV-tenant
-- concern; it is now nullable and undefaulted, and NULL means "not applicable".
--
-- WHY (owner): `deliverables.owner` is free text, so an assignee could not be
-- resolved to a person, permission-checked, or notified. `owner_user_id` is the
-- real reference. The text column is deliberately KEPT for one release so no
-- existing value is destroyed; readers prefer owner_user_id and fall back.

-- 1) Drop the default and the NOT NULL on all four register models.
ALTER TABLE "risks"           ALTER COLUMN "classification" DROP NOT NULL,
                              ALTER COLUMN "classification" DROP DEFAULT;
ALTER TABLE "deliverables"    ALTER COLUMN "classification" DROP NOT NULL,
                              ALTER COLUMN "classification" DROP DEFAULT;
ALTER TABLE "blockers"        ALTER COLUMN "classification" DROP NOT NULL,
                              ALTER COLUMN "classification" DROP DEFAULT;
ALTER TABLE "change_requests" ALTER COLUMN "classification" DROP NOT NULL,
                              ALTER COLUMN "classification" DROP DEFAULT;

-- 2) Clear the ARTIFACT of the old default, and nothing else.
--
--    Scoped deliberately narrowly, because erasing a classification marking is
--    not a thing to do casually:
--      * only rows in a NON-GOV org  -- a GOV tenant's markings are untouched;
--      * only where the value is exactly 'CUI' -- i.e. indistinguishable from
--        the default nobody chose. Any deliberately-set value (FOUO, PUBLIC,
--        CONFIDENTIAL, UNCLASSIFIED) is preserved even in a commercial org.
--    Orgs default to tenant_class = 'GOV', so an unconfigured org is treated as
--    GOV here and keeps its markings. This errs toward retention.
UPDATE "risks" r           SET "classification" = NULL FROM "organizations" o
  WHERE o.id = r."org_id" AND o."tenant_class" <> 'GOV' AND r."classification" = 'CUI';
UPDATE "deliverables" d    SET "classification" = NULL FROM "organizations" o
  WHERE o.id = d."org_id" AND o."tenant_class" <> 'GOV' AND d."classification" = 'CUI';
UPDATE "blockers" b        SET "classification" = NULL FROM "organizations" o
  WHERE o.id = b."org_id" AND o."tenant_class" <> 'GOV' AND b."classification" = 'CUI';
UPDATE "change_requests" c SET "classification" = NULL FROM "organizations" o
  WHERE o.id = c."org_id" AND o."tenant_class" <> 'GOV' AND c."classification" = 'CUI';

-- 3) Deliverable owner FK. Additive; the free-text `owner` column is untouched.
--    No backfill: matching names to users is guesswork, and a wrong assignee is
--    worse than an empty one. Existing text stays readable until someone sets a
--    real owner.
ALTER TABLE "deliverables" ADD COLUMN "owner_user_id" UUID;
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "deliverables_org_id_owner_user_id_idx" ON "deliverables"("org_id", "owner_user_id");
