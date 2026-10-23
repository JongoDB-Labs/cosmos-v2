-- Saved filters v2 (query design §10): the Issues "saved view" becomes a saved
-- CQL filter with a visibility, explicit co-editors and per-user stars.
--
-- Additive only. The legacy `filter` and `shared` columns stay for one
-- release, written alongside the new ones, so older clients keep working.
-- `query` is NOT backfilled here: it is computed from `filter` by TypeScript
-- (fromWorkItemFilter), lazily on read and by scripts/backfill-saved-view-cql.ts.

-- CreateEnum
CREATE TYPE "FilterVisibility" AS ENUM ('PRIVATE', 'TEAM', 'PROJECT', 'ORG');

-- AlterTable
ALTER TABLE "saved_views" ADD COLUMN     "cql_text" TEXT,
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "display" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "project_id" UUID,
ADD COLUMN     "query" JSONB,
ADD COLUMN     "team_id" UUID,
ADD COLUMN     "visibility" "FilterVisibility" NOT NULL DEFAULT 'PRIVATE';

-- Backfill: a view shared with the org is ORG-visible; everything else stays
-- PRIVATE (the column default), exactly who could see it before.
UPDATE "saved_views" SET "visibility" = 'ORG' WHERE "shared" = true;

-- CreateTable
CREATE TABLE "saved_view_favorites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "saved_view_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_view_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_view_editors" (
    "saved_view_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "saved_view_editors_pkey" PRIMARY KEY ("saved_view_id","user_id")
);

-- DropIndex: (org_id, visibility) below covers org_id lookups.
DROP INDEX "saved_views_org_id_idx";

-- CreateIndex
CREATE INDEX "saved_views_org_id_visibility_idx" ON "saved_views"("org_id", "visibility");

-- CreateIndex
CREATE INDEX "saved_views_project_id_idx" ON "saved_views"("project_id");

-- CreateIndex
CREATE INDEX "saved_view_favorites_user_id_idx" ON "saved_view_favorites"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_view_favorites_saved_view_id_user_id_key" ON "saved_view_favorites"("saved_view_id", "user_id");

-- CreateIndex
CREATE INDEX "saved_view_editors_user_id_idx" ON "saved_view_editors"("user_id");

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_view_favorites" ADD CONSTRAINT "saved_view_favorites_saved_view_id_fkey" FOREIGN KEY ("saved_view_id") REFERENCES "saved_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_view_favorites" ADD CONSTRAINT "saved_view_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_view_editors" ADD CONSTRAINT "saved_view_editors_saved_view_id_fkey" FOREIGN KEY ("saved_view_id") REFERENCES "saved_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_view_editors" ADD CONSTRAINT "saved_view_editors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
