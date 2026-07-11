-- Distinct feedback status for work parked in human review (a built draft PR
-- awaiting approval) — previously lumped into IN_PROGRESS, which read as
-- "actively being built" when it was actually waiting on a person.
ALTER TYPE "FeedbackStatus" ADD VALUE IF NOT EXISTS 'IN_REVIEW';
