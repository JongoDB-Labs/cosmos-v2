-- CDRLs are scoped to contracts, and a project may have one or more contracts.
--
-- Three changes, additive except for where uniqueness lives:
--   1. `contracts.project_id` becomes a real foreign key (it has been a bare
--      UUID with an index and no constraint). SET NULL on delete: a contract is
--      a commercial record that outlives the project it was raised for.
--   2. `deliverables` gains `contract_id` (+ FK), `pi_objective`, `due_gate`
--      and `interval_id` (+ FK). All nullable — no existing row has any of them.
--   3. A deliverable's code becomes unique within its CONTRACT rather than
--      across the whole org.
--
-- (3) IS THE DANGEROUS PART. Postgres treats NULLs as distinct, so
-- UNIQUE(org_id, contract_id, code) constrains nothing where contract_id IS
-- NULL — which is EVERY row that exists today. Dropping
-- `deliverables_org_id_code_key` on its own would therefore silently remove the
-- only protection those rows have. The partial unique index at the bottom
-- restores exactly that guarantee, and Prisma cannot express it, so it lives
-- only here (noted on the model in schema.prisma, the way
-- `workflows_org_template_name_key` is).
--
-- Net effect: unassigned deliverables keep today's behaviour byte for byte;
-- contract-scoped ones may reuse an item number across contracts.

-- There has never been a foreign key on contracts.project_id, so a deleted
-- project could leave a contract pointing at a row that no longer exists, and
-- AddForeignKey below would fail on it. Clear those first — NULL is precisely
-- what the new ON DELETE SET NULL would have written at delete time. No-op on
-- any database whose contracts all point at live projects.
UPDATE "contracts" SET "project_id" = NULL
 WHERE "project_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = "contracts"."project_id");

-- DropIndex
DROP INDEX "deliverables_org_id_code_key";

-- AlterTable
ALTER TABLE "deliverables" ADD COLUMN     "contract_id" UUID,
ADD COLUMN     "due_gate" TEXT,
ADD COLUMN     "interval_id" UUID,
ADD COLUMN     "pi_objective" TEXT;

-- CreateIndex
CREATE INDEX "deliverables_contract_id_idx" ON "deliverables"("contract_id");

-- CreateIndex
CREATE INDEX "deliverables_interval_id_idx" ON "deliverables"("interval_id");

-- CreateIndex
CREATE UNIQUE INDEX "deliverables_org_id_contract_id_code_key" ON "deliverables"("org_id", "contract_id", "code");

-- CreateIndex: the half Prisma cannot express — the guarantee the dropped
-- `deliverables_org_id_code_key` gave every row whose contract_id IS NULL.
-- Without it, the DropIndex above is a silent loss of uniqueness for all of
-- them. Cannot fail on existing data: those rows were unique on (org_id, code)
-- a moment ago.
CREATE UNIQUE INDEX "deliverables_org_code_unassigned_key"
  ON "deliverables" ("org_id", "code")
  WHERE "contract_id" IS NULL;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_interval_id_fkey" FOREIGN KEY ("interval_id") REFERENCES "intervals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
