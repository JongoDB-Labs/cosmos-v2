-- Bind sign-in identities to the provider's subject, not to an email address.
--
-- 1. microsoft_identities: the Entra (tenant id, object id) bound to an account.
--    Microsoft sign-in used to match accounts by email alone.
-- 2. federated_identities.issuer: the token issuer that made an SSO binding, so a
--    connection re-pointed at another IdP cannot inherit the old IdP's subjects.
--    Null on existing rows; the next sign-in through the connection records it.
-- 3. users.sso_provisioned: the account was created by an organization's IdP
--    (SSO just-in-time provisioning), so its email was never verified by a
--    first-party provider. Such an account is never a system admin, and Google or
--    Microsoft sign-in never links to it by email.
--
--    Backfill, conservatively, only where the evidence says the IdP made the
--    account: an SSO binding made within a minute of the account itself (the JIT
--    path creates both together) AND no first-party credential at all: no Google
--    identity, no password. An account that has either may have been made by its
--    owner (a Google sign-up, or an email-and-password invitation, which creates
--    the account with a password) and linked to SSO moments later, and flagging
--    it would refuse its owner. Accepted invitations leave no row behind (the
--    invitation is deleted), so the credential columns are the evidence. Bots
--    are excluded. An instance admin can clear a wrong flag in Sign-in providers.
-- 4. users.password_untrusted: the password may have been set from an SSO session
--    (setting a first password used to need only a session), so it doesn't
--    vouch for the address and a password session never carries system admin.
--
--    Backfill: a password last set after the account's first SSO binding, or
--    with no recorded set time. This is conservative: it also catches passwords
--    the owner set or reset legitimately after their org's SSO was linked. The
--    owner's next emailed reset clears it.
--
-- One DO block, so it applies all-or-nothing: `prisma migrate deploy` sends each
-- top-level statement on its own, without a transaction.
DO $$
BEGIN
  CREATE TABLE "microsoft_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "microsoft_identities_pkey" PRIMARY KEY ("id")
  );
  CREATE UNIQUE INDEX "microsoft_identities_user_id_key" ON "microsoft_identities"("user_id");
  CREATE UNIQUE INDEX "microsoft_identities_tenant_id_object_id_key" ON "microsoft_identities"("tenant_id", "object_id");
  ALTER TABLE "microsoft_identities" ADD CONSTRAINT "microsoft_identities_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  ALTER TABLE "federated_identities" ADD COLUMN "issuer" TEXT;

  ALTER TABLE "users" ADD COLUMN "sso_provisioned" BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE "users" ADD COLUMN "password_untrusted" BOOLEAN NOT NULL DEFAULT false;

  -- backfill:begin (run as written by the backfill test)
  UPDATE "users" u
     SET "sso_provisioned" = true
   WHERE u."is_bot" = false
     AND u."google_id" IS NULL
     AND u."password_hash" IS NULL
     AND NOT EXISTS (SELECT 1 FROM "microsoft_identities" mi WHERE mi."user_id" = u."id")
     AND EXISTS (
       SELECT 1
         FROM "federated_identities" fi
        WHERE fi."user_id" = u."id"
          AND fi."created_at" <= u."created_at" + INTERVAL '1 minute'
     );

  UPDATE "users" u
     SET "password_untrusted" = true
   WHERE u."password_hash" IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM "federated_identities" fi
        WHERE fi."user_id" = u."id"
          AND (u."password_set_at" IS NULL OR fi."created_at" <= u."password_set_at")
     );
  -- backfill:end
END $$;
