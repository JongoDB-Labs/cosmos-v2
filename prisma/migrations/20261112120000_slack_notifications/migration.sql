-- Slack notifications: an org's "Add to Slack" install (its bot token is
-- sealed in connector_credentials, never here), how each member is linked to
-- a Slack user, and the direct messages waiting to be sent.
-- New tables only. Everything cascades with its org or person.

-- CreateEnum
CREATE TYPE "SlackLinkStatus" AS ENUM ('LINKED', 'NEEDS_REVIEW', 'UNLINKED', 'NO_MATCH');

-- CreateTable
CREATE TABLE "slack_installations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "team_id" TEXT NOT NULL,
    "team_name" TEXT NOT NULL DEFAULT '',
    "bot_user_id" TEXT,
    "app_id" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "installed_by_id" UUID NOT NULL,
    "public_origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_delivered_at" TIMESTAMP(3),
    "last_error_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_user_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "SlackLinkStatus" NOT NULL,
    "slack_team_id" TEXT,
    "slack_user_id" TEXT,
    "notify_types" TEXT[] DEFAULT ARRAY['assigned', 'mentioned']::TEXT[],
    "approved_by_id" UUID,
    "checked_at" TIMESTAMP(3),
    "linked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_user_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_installations_org_id_key" ON "slack_installations"("org_id");

-- One org per Slack workspace: two would share one bot token, and either
-- one's disconnect would revoke it for both. Disconnect deletes the row.
CREATE UNIQUE INDEX "slack_installations_team_id_key" ON "slack_installations"("team_id");

-- CreateIndex
CREATE INDEX "slack_user_links_org_id_slack_user_id_idx" ON "slack_user_links"("org_id", "slack_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "slack_user_links_org_id_user_id_key" ON "slack_user_links"("org_id", "user_id");

-- Two Cosmos members never land on one Slack user unless an admin allows it:
-- at most one LINKED row per (org, Slack user) that no admin approved. Prisma
-- can't model a partial unique index; the matcher relies on this to turn a
-- concurrent second match into NEEDS_REVIEW.
CREATE UNIQUE INDEX "slack_user_links_one_unapproved" ON "slack_user_links"("org_id", "slack_user_id")
    WHERE "status" = 'LINKED' AND "approved_by_id" IS NULL;

-- CreateIndex
CREATE INDEX "slack_outbox_next_attempt_at_idx" ON "slack_outbox"("next_attempt_at");

-- AddForeignKey
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
