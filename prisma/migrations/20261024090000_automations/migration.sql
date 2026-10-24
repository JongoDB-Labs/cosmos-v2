-- Workflow P4: automations and the outbox's consumers.
--
-- automation_rules / automation_runs hold the rule engine (P4b). webhook_deliveries
-- gains the event it delivers and when it's next tried, so the outbox worker can
-- queue one delivery per webhook per event and a sender can retry it with backoff.
-- Nothing here changes existing rows: the new columns are nullable, and no
-- delivery has an event_id yet, so the new unique index holds for every row.

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('SUCCESS', 'NO_MATCH', 'PARTIAL', 'FAILED', 'LOOP', 'THROTTLED', 'SKIPPED_SELF');

-- AlterTable
ALTER TABLE "webhook_deliveries" ADD COLUMN     "event_id" BIGINT,
ADD COLUMN     "next_attempt_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "spec" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "actor_cap" TEXT NOT NULL,
    "owner_id" UUID,
    "allow_chain" BOOLEAN NOT NULL DEFAULT false,
    "template_key" TEXT,
    "disabled_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_revision" INTEGER NOT NULL,
    "event_id" BIGINT,
    "correlation_id" UUID NOT NULL,
    "depth" INTEGER NOT NULL,
    "status" "AutomationRunStatus" NOT NULL,
    "items_matched" INTEGER NOT NULL DEFAULT 0,
    "actions" JSONB NOT NULL DEFAULT '[]',
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_rules_org_id_project_id_enabled_idx" ON "automation_rules"("org_id", "project_id", "enabled");

-- CreateIndex
CREATE INDEX "automation_runs_org_id_created_at_idx" ON "automation_runs"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "automation_runs_rule_id_created_at_idx" ON "automation_runs"("rule_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_rule_id_event_id_key" ON "automation_runs"("rule_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_webhook_id_event_id_event_key" ON "webhook_deliveries"("webhook_id", "event_id", "event");

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The sender reads only queued deliveries, the soonest due first.
CREATE INDEX "webhook_deliveries_pending_idx" ON "webhook_deliveries"("next_attempt_at") WHERE "status" = 'PENDING';
