-- COSMOS-206: why a work item was cancelled. Additive and nullable, so every
-- existing row reads as "not cancelled with a reason".
CREATE TYPE "CancelReason" AS ENUM ('OBE', 'OTHER');

ALTER TABLE "work_items" ADD COLUMN "cancel_reason" "CancelReason",
ADD COLUMN "cancel_note" TEXT;
