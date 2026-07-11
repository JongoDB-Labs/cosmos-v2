-- Hand-authored, additive migration (no dev DB / `prisma migrate dev`; applied
-- via `prisma migrate deploy`). Adds objective↔work-item / objective↔objective
-- links so an objective can track deliverables and dependencies. Soft references
-- (no FK on work_item_id / depends_on_objective_id) mirror goal_links.

-- CreateEnum
CREATE TYPE "ObjectiveLinkKind" AS ENUM ('WORK_ITEM', 'DEPENDS_ON');

-- CreateTable
CREATE TABLE "objective_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "objective_id" UUID NOT NULL,
    "kind" "ObjectiveLinkKind" NOT NULL,
    "work_item_id" UUID,
    "depends_on_objective_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "objective_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "objective_links_objective_id_idx" ON "objective_links"("objective_id");

-- AddForeignKey
ALTER TABLE "objective_links" ADD CONSTRAINT "objective_links_objective_id_fkey" FOREIGN KEY ("objective_id") REFERENCES "objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
