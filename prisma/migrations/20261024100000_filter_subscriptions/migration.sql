-- CQL phase 6: emailed saved filters (query design §12.4).
-- Additive: one enum, one table, its indexes and foreign keys.

-- CreateEnum
CREATE TYPE "FilterSubscriptionFormat" AS ENUM ('LIST', 'COUNT');

-- CreateTable
CREATE TABLE "filter_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "saved_view_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "recipient_user_id" UUID,
    "recipient_team_id" UUID,
    "cron" TEXT NOT NULL DEFAULT '0 8 * * 1-5',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "format" "FilterSubscriptionFormat" NOT NULL DEFAULT 'LIST',
    "send_when_empty" BOOLEAN NOT NULL DEFAULT false,
    "only_changes" BOOLEAN NOT NULL DEFAULT false,
    "last_run_at" TIMESTAMP(3),
    "last_result_hash" TEXT,
    "last_result_ids" JSONB NOT NULL DEFAULT '{}',
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "disabled_at" TIMESTAMP(3),
    "disabled_reason" TEXT,
    "muted_user_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "unsubscribe_key" TEXT NOT NULL,
    "app_origin" TEXT NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "filter_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "filter_subscriptions_next_run_at_idx" ON "filter_subscriptions"("next_run_at");

-- CreateIndex
CREATE INDEX "filter_subscriptions_org_id_idx" ON "filter_subscriptions"("org_id");

-- CreateIndex
CREATE INDEX "filter_subscriptions_saved_view_id_idx" ON "filter_subscriptions"("saved_view_id");

-- AddForeignKey
ALTER TABLE "filter_subscriptions" ADD CONSTRAINT "filter_subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_subscriptions" ADD CONSTRAINT "filter_subscriptions_saved_view_id_fkey" FOREIGN KEY ("saved_view_id") REFERENCES "saved_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_subscriptions" ADD CONSTRAINT "filter_subscriptions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_subscriptions" ADD CONSTRAINT "filter_subscriptions_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_subscriptions" ADD CONSTRAINT "filter_subscriptions_recipient_team_id_fkey" FOREIGN KEY ("recipient_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
