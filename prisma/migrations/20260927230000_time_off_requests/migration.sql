-- Somebody being away: asked for, decided on, reserved against their week.
CREATE TYPE "TimeOffKind" AS ENUM ('VACATION', 'SICK', 'HOLIDAY', 'UNPAID', 'PARENTAL', 'BEREAVEMENT', 'OTHER');
CREATE TYPE "TimeOffStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'WITHDRAWN');

CREATE TABLE "time_off_requests" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"        UUID NOT NULL,
    "user_id"       UUID NOT NULL,
    "kind"          "TimeOffKind" NOT NULL,
    "status"        "TimeOffStatus" NOT NULL DEFAULT 'PENDING',
    "start_date"    DATE NOT NULL,
    "end_date"      DATE NOT NULL,
    "hours_per_day" DECIMAL(5,2) NOT NULL DEFAULT 8,
    "note"          TEXT,
    "decided_by_id" UUID,
    "decided_at"    TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "time_off_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "time_off_requests_org_id_user_id_start_date_idx" ON "time_off_requests"("org_id", "user_id", "start_date");
CREATE INDEX "time_off_requests_org_id_status_idx" ON "time_off_requests"("org_id", "status");
CREATE INDEX "time_off_requests_org_id_start_date_end_date_idx" ON "time_off_requests"("org_id", "start_date", "end_date");

ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
