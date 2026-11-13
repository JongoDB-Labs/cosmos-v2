-- Previews of confirm-class assistant tool calls (deletes, member removals,
-- closing a ceremony, bulk changes) that wait for the user's answer.
--
-- The model gets a token: an HMAC, under a key derived from the vault key,
-- over this row's nonce (its id), the user, org, conversation, tool, and
-- hashes of the arguments and the resolved targets. The token commits the
-- change only in a run started by a newer USER message than
-- `after_message_id`, within `expires_at`, and once: `used_at` is set by a
-- conditional update, so two instances can't both spend it.
--
-- Rows are short-lived. Issuing a preview deletes the conversation's
-- long-expired rows, and deleting the conversation, its org or its user
-- cascades here.
-- cosmos_app gets its DML through the default privileges set in
-- 20260606050000_audit_immutability.

CREATE TABLE "assistant_confirmations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "args_hash" TEXT NOT NULL,
    "ids_hash" TEXT NOT NULL,
    "target_count" INTEGER NOT NULL,
    "after_message_id" UUID NOT NULL,
    "kid" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_confirmations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_confirmations_conversation_id_used_at_idx" ON "assistant_confirmations"("conversation_id", "used_at");

ALTER TABLE "assistant_confirmations" ADD CONSTRAINT "assistant_confirmations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assistant_confirmations" ADD CONSTRAINT "assistant_confirmations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assistant_confirmations" ADD CONSTRAINT "assistant_confirmations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
