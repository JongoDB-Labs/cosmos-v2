-- Email/password invite onboarding (additive; preserves the existing OAuth invite flow).
-- New per-user onboarding flags and per-invitation sign-in method.

ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "mfa_required" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "invitations" ADD COLUMN "sign_in_method" TEXT NOT NULL DEFAULT 'oauth';
ALTER TABLE "invitations" ADD COLUMN "mfa_required" BOOLEAN NOT NULL DEFAULT false;
