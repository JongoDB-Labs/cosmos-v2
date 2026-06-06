CREATE TABLE "egress_decisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" TEXT NOT NULL,
  "turn" INTEGER NOT NULL,
  "value_kind" TEXT NOT NULL,
  "tool_name" TEXT,
  "exposed" BOOLEAN NOT NULL,
  "withheld_count" INTEGER NOT NULL,
  "content_hash" TEXT NOT NULL,
  "decided_by" TEXT NOT NULL,
  "tenant_class" TEXT NOT NULL,
  "ceiling" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "egress_decisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "egress_decisions_conversation_id_created_at_idx" ON "egress_decisions"("conversation_id", "created_at");
