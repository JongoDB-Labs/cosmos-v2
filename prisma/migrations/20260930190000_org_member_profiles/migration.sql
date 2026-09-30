-- How a member of an organization is staffed and charged out, promoted from a
-- vertical plugin into core.
--
-- Safe to re-run: a fresh install gets an empty table, while a deployment that
-- already holds this data runs a later migration of its own that moves the rows
-- in and drops the old table.
--
-- user_id carries no foreign key on purpose. A profile may describe somebody
-- who is not a member of the org -- a name that arrived through an import, or
-- someone whose membership has ended while the firm still wants their rate on
-- record. Two of the five rows on the reference deployment are in exactly that
-- state, so a constraint here would not be a tightening, it would be a deletion.

-- CreateTable
CREATE TABLE IF NOT EXISTS "org_member_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rate_level_key" TEXT NOT NULL,
    "weekly_capacity" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "in_training" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "org_member_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "org_member_profiles_org_id_user_id_key" ON "org_member_profiles"("org_id", "user_id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_member_profiles_org_id_fkey') THEN
    ALTER TABLE "org_member_profiles" ADD CONSTRAINT "org_member_profiles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
