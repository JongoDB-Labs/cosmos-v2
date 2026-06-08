-- Local username/password + TOTP MFA columns on users (additive, nullable/defaulted).
ALTER TABLE "users"
  ADD COLUMN "password_hash" TEXT,
  ADD COLUMN "password_set_at" TIMESTAMP(3),
  ADD COLUMN "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mfa_secret" TEXT,
  ADD COLUMN "mfa_recovery_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "mfa_enrolled_at" TIMESTAMP(3);
