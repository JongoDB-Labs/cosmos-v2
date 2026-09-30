-- RateLevel: a firm's charge-out ladder, promoted from a vertical plugin.
--
-- IDEMPOTENT ON PURPOSE. Two kinds of database arrive here:
--
--   a fresh install, where nothing of the sort exists and this creates it;
--   a branded install, where the same rows already live under a table this
--   repo is not allowed to name. That install gets its data carried across by
--   the vertical's own migration, in its own private repo, which runs after
--   this one and may name what it is moving.
--
-- Hence CREATE ... IF NOT EXISTS throughout, and exception-guarded CREATE TYPE
-- (Postgres has no IF NOT EXISTS for a type): this file must be safe to apply
-- to a database the other half has already carried part of the way.

DO $$ BEGIN
  CREATE TYPE "Band" AS ENUM ('ASSOCIATE', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "UtilizationBand" AS ENUM ('TECHNICAL', 'PRINCIPAL', 'SUPPORT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "rate_levels" (
  "id"               UUID           NOT NULL DEFAULT gen_random_uuid(),
  "org_id"           UUID           NOT NULL,
  "key"              TEXT           NOT NULL,
  "name"             TEXT           NOT NULL,
  "hourly_rate"      DECIMAL(19, 4) NOT NULL,
  "band"             "Band"         NOT NULL DEFAULT 'OTHER',
  "utilization_band" "UtilizationBand",
  "sort_order"       INTEGER        NOT NULL DEFAULT 0,

  CONSTRAINT "rate_levels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "rate_levels_org_id_key_key"
  ON "rate_levels" ("org_id", "key");

DO $$ BEGIN
  ALTER TABLE "rate_levels"
    ADD CONSTRAINT "rate_levels_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
