-- CreateEnum
CREATE TYPE "ChatChannelKind" AS ENUM ('CHANNEL', 'DM', 'GROUP_DM');

-- CreateEnum
CREATE TYPE "ChatChannelMemberRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ChatNotificationPref" AS ENUM ('ALL', 'MENTIONS', 'MUTED');

-- AlterTable: add `url` column to notifications
ALTER TABLE "notifications" ADD COLUMN "url" TEXT;

-- CreateTable: chat_channels
CREATE TABLE "chat_channels" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"          UUID NOT NULL,
    "kind"            "ChatChannelKind" NOT NULL,
    "name"            TEXT,
    "slug"            TEXT,
    "description"     TEXT,
    "topic"           TEXT,
    "is_private"      BOOLEAN NOT NULL DEFAULT FALSE,
    "is_general"      BOOLEAN NOT NULL DEFAULT FALSE,
    "project_id"      UUID,
    "created_by_id"   UUID NOT NULL,
    "dm_key"          TEXT,
    "last_message_at" TIMESTAMP(3),
    "archived_at"     TIMESTAMP(3),
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "chat_channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_channels_org_id_slug_key" ON "chat_channels"("org_id", "slug");
CREATE UNIQUE INDEX "chat_channels_org_id_dm_key_key" ON "chat_channels"("org_id", "dm_key");
CREATE INDEX "chat_channels_org_id_kind_archived_at_idx" ON "chat_channels"("org_id", "kind", "archived_at");
CREATE INDEX "chat_channels_org_id_last_message_at_idx" ON "chat_channels"("org_id", "last_message_at");
CREATE INDEX "chat_channels_project_id_idx" ON "chat_channels"("project_id");

ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: chat_channel_members
CREATE TABLE "chat_channel_members" (
    "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel_id"            UUID NOT NULL,
    "user_id"               UUID NOT NULL,
    "role"                  "ChatChannelMemberRole" NOT NULL DEFAULT 'MEMBER',
    "notification_pref"     "ChatNotificationPref"  NOT NULL DEFAULT 'MENTIONS',
    "last_read_message_id"  UUID,
    "last_read_at"          TIMESTAMP(3),
    "muted_until"           TIMESTAMP(3),
    "joined_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_channel_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_channel_members_channel_id_user_id_key" ON "chat_channel_members"("channel_id", "user_id");
CREATE INDEX "chat_channel_members_user_id_channel_id_idx" ON "chat_channel_members"("user_id", "channel_id");

ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_channel_id_fkey"
  FOREIGN KEY ("channel_id") REFERENCES "chat_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: chat_messages
CREATE TABLE "chat_messages" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel_id"        UUID NOT NULL,
    "author_id"         UUID NOT NULL,
    "content"           TEXT NOT NULL,
    "parent_message_id" UUID,
    "edited_at"         TIMESTAMP(3),
    "deleted_at"        TIMESTAMP(3),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_messages_channel_id_created_at_idx" ON "chat_messages"("channel_id", "created_at");
CREATE INDEX "chat_messages_channel_id_parent_message_id_created_at_idx" ON "chat_messages"("channel_id", "parent_message_id", "created_at");
CREATE INDEX "chat_messages_author_id_created_at_idx" ON "chat_messages"("author_id", "created_at");

ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_id_fkey"
  FOREIGN KEY ("channel_id") REFERENCES "chat_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_parent_message_id_fkey"
  FOREIGN KEY ("parent_message_id") REFERENCES "chat_messages"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- CreateTable: chat_message_reactions
CREATE TABLE "chat_message_reactions" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL,
    "user_id"    UUID NOT NULL,
    "emoji"      TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_message_reactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_message_reactions_message_id_user_id_emoji_key" ON "chat_message_reactions"("message_id", "user_id", "emoji");
CREATE INDEX "chat_message_reactions_message_id_idx" ON "chat_message_reactions"("message_id");

ALTER TABLE "chat_message_reactions" ADD CONSTRAINT "chat_message_reactions_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: chat_message_attachments
CREATE TABLE "chat_message_attachments" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id"     UUID,
    "kind"           TEXT NOT NULL,
    "url"            TEXT NOT NULL,
    "storage_key"    TEXT NOT NULL,
    "filename"       TEXT NOT NULL,
    "content_type"   TEXT NOT NULL,
    "size"           INTEGER NOT NULL,
    "width"          INTEGER,
    "height"         INTEGER,
    "uploaded_by_id" UUID NOT NULL,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_message_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_message_attachments_message_id_idx" ON "chat_message_attachments"("message_id");
CREATE INDEX "chat_message_attachments_uploaded_by_id_created_at_idx" ON "chat_message_attachments"("uploaded_by_id", "created_at");

ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: chat_message_mentions
CREATE TABLE "chat_message_mentions" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL,
    "user_id"    UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_message_mentions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_message_mentions_message_id_user_id_key" ON "chat_message_mentions"("message_id", "user_id");
CREATE INDEX "chat_message_mentions_user_id_created_at_idx" ON "chat_message_mentions"("user_id", "created_at");

ALTER TABLE "chat_message_mentions" ADD CONSTRAINT "chat_message_mentions_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed #general for every existing organization (one channel per org, auto-joined by every existing org member)
-- The created_by_id picks the longest-tenured org member as the channel admin.
INSERT INTO "chat_channels" (id, org_id, kind, name, slug, is_private, is_general, created_by_id, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  'CHANNEL',
  'general',
  'general',
  FALSE,
  TRUE,
  (SELECT user_id FROM "org_members" WHERE org_id = o.id ORDER BY joined_at ASC LIMIT 1),
  now(),
  now()
FROM "organizations" o
WHERE
  EXISTS (SELECT 1 FROM "org_members" WHERE org_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM "chat_channels" c WHERE c.org_id = o.id AND c.is_general = TRUE);

-- Auto-join every existing OrgMember to their org's #general
INSERT INTO "chat_channel_members" (id, channel_id, user_id, role, notification_pref, joined_at)
SELECT
  gen_random_uuid(),
  c.id,
  m.user_id,
  CASE WHEN m.role IN ('OWNER', 'ADMIN') THEN 'ADMIN'::"ChatChannelMemberRole" ELSE 'MEMBER'::"ChatChannelMemberRole" END,
  'MENTIONS'::"ChatNotificationPref",
  now()
FROM "chat_channels" c
JOIN "org_members" m ON m.org_id = c.org_id
WHERE c.is_general = TRUE
ON CONFLICT (channel_id, user_id) DO NOTHING;
