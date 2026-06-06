CREATE TABLE "chat_pinned_messages" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel_id"    UUID NOT NULL,
    "message_id"    UUID NOT NULL,
    "pinned_by_id"  UUID NOT NULL,
    "pinned_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_pinned_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chat_pinned_messages_channel_id_message_id_key" ON "chat_pinned_messages"("channel_id", "message_id");
CREATE INDEX "chat_pinned_messages_channel_id_pinned_at_idx" ON "chat_pinned_messages"("channel_id", "pinned_at");
ALTER TABLE "chat_pinned_messages" ADD CONSTRAINT "chat_pinned_messages_channel_id_fkey"
  FOREIGN KEY ("channel_id") REFERENCES "chat_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_pinned_messages" ADD CONSTRAINT "chat_pinned_messages_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
