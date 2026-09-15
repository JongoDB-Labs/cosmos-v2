-- Standing flags: a condition worth attention, open until it stops being true.
--
-- Distinct from notifications, which are per-user, read once and gone. A flag is
-- org-level state with a severity and a lifecycle: it answers "what is wrong
-- right now", where a notification answers "did anyone tell me".

-- CreateEnum
CREATE TYPE "flag_severity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
-- CreateEnum
CREATE TYPE "flag_status" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
-- CreateTable
CREATE TABLE "flags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" "flag_severity" NOT NULL,
    "status" "flag_status" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "project_id" UUID,
    "user_id" UUID,
    "subject_type" TEXT,
    "subject_id" TEXT,
    "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" UUID,
    CONSTRAINT "flags_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "flags_org_id_status_severity_idx" ON "flags"("org_id", "status", "severity");
-- CreateIndex
CREATE INDEX "flags_org_id_rule_status_idx" ON "flags"("org_id", "rule", "status");
-- AddForeignKey
ALTER TABLE "flags" ADD CONSTRAINT "flags_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "flags" ADD CONSTRAINT "flags_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ONE open flag per rule per subject. This is what lets a rule run on a timer
-- and stay idempotent: re-raising an existing condition updates it instead of
-- stacking a second copy, and a nightly sweep does not produce a nightly pile.
--
-- PARTIAL, on status='OPEN' only. Resolved and dismissed flags are history and
-- must be allowed to repeat: the same condition recurring next month is a new
-- fact, not a constraint violation. COALESCE because NULLs are distinct in a
-- unique index, so without it two flags with no subject would both be allowed.
CREATE UNIQUE INDEX "flags_one_open_per_rule_subject"
  ON "flags" (
    "org_id",
    "rule",
    COALESCE("project_id"::text, ''),
    COALESCE("user_id"::text, ''),
    COALESCE("subject_type", ''),
    COALESCE("subject_id", '')
  )
  WHERE "status" = 'OPEN';
