-- Rename ChatRole enum → AssistantMessageRole
ALTER TYPE "ChatRole" RENAME TO "AssistantMessageRole";

-- Rename tables (preserves all data)
ALTER TABLE "chat_conversations" RENAME TO "assistant_conversations";
ALTER TABLE "chat_messages" RENAME TO "assistant_messages";

-- Rename indexes
ALTER INDEX "chat_conversations_org_id_user_id_idx" RENAME TO "assistant_conversations_org_id_user_id_idx";
ALTER INDEX "chat_messages_conversation_id_created_at_idx" RENAME TO "assistant_messages_conversation_id_created_at_idx";

-- Rename PK/FK constraints to match the new table names (Postgres constraint names are unique per schema)
ALTER TABLE "assistant_conversations" RENAME CONSTRAINT "chat_conversations_pkey" TO "assistant_conversations_pkey";
ALTER TABLE "assistant_conversations" RENAME CONSTRAINT "chat_conversations_org_id_fkey" TO "assistant_conversations_org_id_fkey";
ALTER TABLE "assistant_messages" RENAME CONSTRAINT "chat_messages_pkey" TO "assistant_messages_pkey";
ALTER TABLE "assistant_messages" RENAME CONSTRAINT "chat_messages_conversation_id_fkey" TO "assistant_messages_conversation_id_fkey";
