CREATE TYPE "ChatMessageKind" AS ENUM ('USER', 'ACTION', 'SYSTEM', 'ASSISTANT');
ALTER TABLE "chat_messages"
  ADD COLUMN "kind" "ChatMessageKind" NOT NULL DEFAULT 'USER';
