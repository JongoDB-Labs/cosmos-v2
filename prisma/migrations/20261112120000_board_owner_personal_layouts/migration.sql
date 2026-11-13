-- Who made a board, and each person's own arrangement of a dashboard.
--
-- boards.owner_id: the creator. Lets a member change the dashboard they made
-- without being a project manager. Null on every existing board, which keeps
-- every existing board exactly as editable as it was: managers only.
--
-- personal_board_layouts: one row per (board, person). Changes what that
-- person sees on the dashboard and nothing else.
--
-- One DO block, so the whole change is one statement and one transaction:
-- `prisma migrate deploy` sends a parsable multi-statement file one statement
-- at a time, and a failure halfway would leave the column without the table.

DO $$ BEGIN
  ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "owner_id" UUID;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boards_owner_id_fkey') THEN
    ALTER TABLE "boards" ADD CONSTRAINT "boards_owner_id_fkey"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  CREATE TABLE IF NOT EXISTS "personal_board_layouts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "widgets" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "personal_board_layouts_pkey" PRIMARY KEY ("id")
  );

  CREATE INDEX IF NOT EXISTS "personal_board_layouts_user_id_idx"
    ON "personal_board_layouts"("user_id");
  CREATE UNIQUE INDEX IF NOT EXISTS "personal_board_layouts_board_id_user_id_key"
    ON "personal_board_layouts"("board_id", "user_id");

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'personal_board_layouts_org_id_fkey') THEN
    ALTER TABLE "personal_board_layouts" ADD CONSTRAINT "personal_board_layouts_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'personal_board_layouts_board_id_fkey') THEN
    ALTER TABLE "personal_board_layouts" ADD CONSTRAINT "personal_board_layouts_board_id_fkey"
      FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'personal_board_layouts_user_id_fkey') THEN
    ALTER TABLE "personal_board_layouts" ADD CONSTRAINT "personal_board_layouts_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
