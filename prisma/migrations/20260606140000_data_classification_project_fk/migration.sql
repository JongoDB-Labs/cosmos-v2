-- §9.2 cutover-baseline reconciliation: the data_classifications.project_id FK.
--
-- Hand-written (no dev DB / `prisma migrate dev`); applied via `prisma migrate deploy`.
--
-- WHY: prod runs the classification-propagation line, where a per-project
-- DataClassification row's `project_id` is a REAL foreign key onto `projects(id)`.
-- The v2 baseline (20260525000000_baseline) carried the COLUMN + the UNIQUE
-- (org_id, project_id) index, but NOT the FK — so a fresh v2 DB was structurally a
-- hair short of the line prod actually runs. This migration adds the missing FK so
-- v2's schema is structurally IDENTICAL to the reconciled prod baseline.
--
-- This is the assertion the cutover schema-parity HARD gate (§9.2,
-- scripts/cutover/parity-gate.mjs) checks in BOTH directions:
--   1. `prisma migrate diff` between a restored prod snapshot and v2's datamodel must be
--      EMPTY — with this FK in the v2 model, a prod snapshot that HAS the FK diffs clean;
--   2. the gate independently asserts the FK EXISTS in the restored prod snapshot — its
--      presence proves the baseline was reconciled from the classification line, not an
--      older branch that predates per-project classification.
--
-- project_id is nullable (NULL = the org-ceiling row); ON DELETE CASCADE mirrors the
-- other per-project FKs (cycles_project_id_fkey, objectives_project_id_fkey): deleting a
-- project removes its classification row. Idempotent: guarded so a re-deploy (or a DB
-- that already carries the FK from a prod restore) is a no-op rather than an error.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'data_classifications_project_id_fkey'
      AND conrelid = 'public.data_classifications'::regclass
  ) THEN
    ALTER TABLE "public"."data_classifications"
      ADD CONSTRAINT "data_classifications_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
