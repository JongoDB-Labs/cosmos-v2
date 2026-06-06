-- SSO Phase 1: in-app OIDC Relying Party.
-- Adds the per-tenant IdP connection, the (idpConnId, subject)-keyed federated
-- identity table (the account-takeover guard — NEVER match on email), and the
-- Session assurance columns.
--
-- Hand-written (no dev DB / `prisma migrate dev`); applied via
-- `prisma migrate deploy` as the OWNER (cosmos). Additive + backwards-compatible:
-- existing sessions get NULL auth_method / NULL idp_conn_id / empty amr /
-- mfa_satisfied=false. Verified in Docker in Task 4.

-- 1. The OIDC protocol enum (SAML added in the Keycloak/SAML follow-on).
CREATE TYPE "IdpProtocol" AS ENUM ('OIDC');

-- 2. Per-tenant IdP connection. One per org for this slice (@@unique([orgId])).
CREATE TABLE "idp_connections" (
    "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
    "org_id"            UUID         NOT NULL,
    "protocol"          "IdpProtocol" NOT NULL DEFAULT 'OIDC',
    "issuer_url"        TEXT         NOT NULL,
    "client_id"         TEXT         NOT NULL,
    "client_secret_enc" TEXT         NOT NULL,
    "scopes"            TEXT[]       NOT NULL DEFAULT ARRAY['openid', 'email', 'profile']::TEXT[],
    "attribute_mapping" JSONB        NOT NULL DEFAULT '{}',
    "role_mapping"      JSONB        NOT NULL DEFAULT '{}',
    "jit_provisioning"  BOOLEAN      NOT NULL DEFAULT true,
    "default_role"      "OrgRole"    NOT NULL DEFAULT 'MEMBER',
    "required_acr"      TEXT,
    "enabled"           BOOLEAN      NOT NULL DEFAULT false,
    "enforced"          BOOLEAN      NOT NULL DEFAULT false,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idp_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idp_connections_org_id_key" ON "idp_connections" ("org_id");

ALTER TABLE "idp_connections"
    ADD CONSTRAINT "idp_connections_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Federated identity. The (idp_conn_id, subject) UNIQUE is the security key:
--    SSO logins are matched on the IdP-asserted stable subject, never on email
--    (users.email is NOT unique → email-only matching would be account-takeover).
CREATE TABLE "federated_identities" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"     UUID         NOT NULL,
    "idp_conn_id" UUID         NOT NULL,
    "subject"     TEXT         NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federated_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "federated_identities_idp_conn_id_subject_key"
    ON "federated_identities" ("idp_conn_id", "subject");
CREATE INDEX "federated_identities_user_id_idx"
    ON "federated_identities" ("user_id");

ALTER TABLE "federated_identities"
    ADD CONSTRAINT "federated_identities_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "federated_identities"
    ADD CONSTRAINT "federated_identities_idp_conn_id_fkey"
    FOREIGN KEY ("idp_conn_id") REFERENCES "idp_connections" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Session assurance columns (additive; defaults keep legacy/Google sessions valid).
ALTER TABLE "sessions"
    ADD COLUMN "auth_method"   TEXT,
    ADD COLUMN "idp_conn_id"   UUID,
    ADD COLUMN "amr"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "mfa_satisfied" BOOLEAN NOT NULL DEFAULT false;
