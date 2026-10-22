-- COSMOS-202: per-person calendar subscription links. Only a SHA-256 of each
-- token is stored; the unique index makes the lookup an exact index hit.
CREATE TABLE "calendar_feeds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "last_fetched_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_feeds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_feeds_token_hash_key" ON "calendar_feeds"("token_hash");
CREATE INDEX "calendar_feeds_org_id_user_id_idx" ON "calendar_feeds"("org_id", "user_id");

ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
