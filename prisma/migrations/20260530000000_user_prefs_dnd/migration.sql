ALTER TABLE "user_preferences"
  ADD COLUMN "dnd_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "dnd_start" TEXT,
  ADD COLUMN "dnd_end" TEXT,
  ADD COLUMN "dnd_timezone" TEXT;
