-- ADR 0003: plugin enablement state (Settings → Plugins). One row per (org, plugin);
-- the ABSENCE of a row — or enabled=false — means the plugin is OFF (fail-closed,
-- the deliberate opposite of org_entitlements' fail-open default). Additive only.
-- Hand-written (repo convention: no `prisma migrate dev` — hand-written SQL applied
-- via `prisma migrate deploy`; a schema↔db diff carries drift from the deliberate
-- out-of-schema audit hardening, so only this table's DDL belongs here).

-- CreateTable
CREATE TABLE "org_plugin_state" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "plugin_slug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled_version" TEXT,
    "enabled_by_id" UUID,
    "enabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_plugin_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_plugin_state_org_id_idx" ON "org_plugin_state"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_plugin_state_org_id_plugin_slug_key" ON "org_plugin_state"("org_id", "plugin_slug");

-- AddForeignKey
ALTER TABLE "org_plugin_state" ADD CONSTRAINT "org_plugin_state_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
