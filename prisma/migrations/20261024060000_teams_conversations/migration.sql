-- COSMOS-202 T2: where the Cosmos bot may write in Teams (a person's chat with
-- the bot, or a channel linked to a project), and the messages waiting to go.
-- New tables only. Everything cascades with its org, person or project.
-- Timestamp: after invite mode's 20261024050000 in the hotspot-prisma queue;
-- re-checked against main when the hotspot reaches this PR.

-- CreateTable
CREATE TABLE "teams_conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID,
    "project_id" UUID,
    "tenant_id" TEXT NOT NULL,
    "service_url" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "notify_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "due_digest_on" DATE,
    "last_event_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "teams_conversation_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_conversations_org_id_user_id_key" ON "teams_conversations"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_conversations_org_id_project_id_key" ON "teams_conversations"("org_id", "project_id");

-- CreateIndex
CREATE INDEX "teams_outbox_next_attempt_at_idx" ON "teams_outbox"("next_attempt_at");

-- AddForeignKey
ALTER TABLE "teams_conversations" ADD CONSTRAINT "teams_conversations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams_conversations" ADD CONSTRAINT "teams_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams_conversations" ADD CONSTRAINT "teams_conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams_outbox" ADD CONSTRAINT "teams_outbox_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams_outbox" ADD CONSTRAINT "teams_outbox_teams_conversation_id_fkey" FOREIGN KEY ("teams_conversation_id") REFERENCES "teams_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one of a person or a project.
ALTER TABLE "teams_conversations" ADD CONSTRAINT "teams_conversations_one_target"
  CHECK ((("user_id" IS NOT NULL)::int + ("project_id" IS NOT NULL)::int) = 1);
