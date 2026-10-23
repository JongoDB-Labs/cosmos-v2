-- Feedback discussion, Phase 1: one schema change for the whole feature.
-- Every new column is nullable or defaulted, so existing work-item, PM-register
-- and document comments read exactly as before (PUBLIC, kind COMMENT).

-- CreateEnum
CREATE TYPE "CommentVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateEnum
CREATE TYPE "CommentKind" AS ENUM ('COMMENT', 'OFFICIAL', 'STATUS_CHANGE', 'MERGE', 'SYSTEM');

-- AlterEnum
ALTER TYPE "FeedbackStatus" ADD VALUE 'MERGED';

-- DropIndex
DROP INDEX "comments_org_id_subject_type_subject_id_idx";

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "classification" "ClassificationLevel",
ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_by_id" UUID,
ADD COLUMN     "edited_at" TIMESTAMP(3),
ADD COLUMN     "hidden_at" TIMESTAMP(3),
ADD COLUMN     "hidden_by_id" UUID,
ADD COLUMN     "hidden_reason" TEXT,
ADD COLUMN     "kind" "CommentKind" NOT NULL DEFAULT 'COMMENT',
ADD COLUMN     "meta" JSONB,
ADD COLUMN     "origin_subject_id" UUID,
ADD COLUMN     "parent_id" UUID,
ADD COLUMN     "visibility" "CommentVisibility" NOT NULL DEFAULT 'PUBLIC';

-- AlterTable
ALTER TABLE "feedback_attachments" ADD COLUMN     "comment_id" UUID;

-- AlterTable
ALTER TABLE "feedback_items" ADD COLUMN     "comment_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_activity_at" TIMESTAMP(3),
ADD COLUMN     "locked_at" TIMESTAMP(3),
ADD COLUMN     "locked_by_id" UUID,
ADD COLUMN     "merged_into_id" UUID,
ADD COLUMN     "official_comment_id" UUID;

-- CreateTable
CREATE TABLE "comment_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "comment_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "edited_by_id" UUID NOT NULL,
    "redacted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_reactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "comment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "feedback_item_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "unsubscribed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_merges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "duplicate_id" UUID NOT NULL,
    "survivor_id" UUID NOT NULL,
    "moved_vote_user_ids" UUID[],
    "moved_comment_ids" UUID[],
    "moved_attachment_ids" UUID[],
    "added_subscriber_ids" UUID[],
    "previous_status" "FeedbackStatus",
    "source" TEXT NOT NULL,
    "merged_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMP(3),
    "undone_by_id" UUID,

    CONSTRAINT "feedback_merges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comment_revisions_comment_id_created_at_idx" ON "comment_revisions"("comment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "comment_reactions_comment_id_user_id_emoji_key" ON "comment_reactions"("comment_id", "user_id", "emoji");

-- CreateIndex
CREATE INDEX "feedback_subscriptions_org_id_user_id_idx" ON "feedback_subscriptions"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_subscriptions_feedback_item_id_user_id_key" ON "feedback_subscriptions"("feedback_item_id", "user_id");

-- CreateIndex
CREATE INDEX "feedback_merges_org_id_survivor_id_idx" ON "feedback_merges"("org_id", "survivor_id");

-- CreateIndex
CREATE INDEX "feedback_merges_duplicate_id_idx" ON "feedback_merges"("duplicate_id");

-- CreateIndex
CREATE INDEX "comments_org_id_subject_type_subject_id_created_at_idx" ON "comments"("org_id", "subject_type", "subject_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_parent_id_idx" ON "comments"("parent_id");

-- CreateIndex
CREATE INDEX "feedback_attachments_comment_id_idx" ON "feedback_attachments"("comment_id");

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_revisions" ADD CONSTRAINT "comment_revisions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_reactions" ADD CONSTRAINT "comment_reactions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_items" ADD CONSTRAINT "feedback_items_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "feedback_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_items" ADD CONSTRAINT "feedback_items_official_comment_id_fkey" FOREIGN KEY ("official_comment_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_attachments" ADD CONSTRAINT "feedback_attachments_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_subscriptions" ADD CONSTRAINT "feedback_subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_subscriptions" ADD CONSTRAINT "feedback_subscriptions_feedback_item_id_fkey" FOREIGN KEY ("feedback_item_id") REFERENCES "feedback_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_merges" ADD CONSTRAINT "feedback_merges_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
