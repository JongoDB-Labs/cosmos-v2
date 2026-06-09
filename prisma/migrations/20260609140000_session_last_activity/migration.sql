-- Sliding-window idle-timeout anchor for the authenticating session.
-- Existing rows start "fresh" (now()) so the deploy doesn't log everyone out.
ALTER TABLE "sessions"
  ADD COLUMN "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
