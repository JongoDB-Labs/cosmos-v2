-- CreateTable
CREATE TABLE "foreman_skills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'authored',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "foreman_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "foreman_mcp_servers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "headers" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "foreman_mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "foreman_harness_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "system_prompt_append" TEXT,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "foreman_harness_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "foreman_skills_org_id_name_key" ON "foreman_skills"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "foreman_mcp_servers_org_id_name_key" ON "foreman_mcp_servers"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "foreman_harness_settings_org_id_key" ON "foreman_harness_settings"("org_id");

-- AddForeignKey
ALTER TABLE "foreman_skills" ADD CONSTRAINT "foreman_skills_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "foreman_mcp_servers" ADD CONSTRAINT "foreman_mcp_servers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "foreman_harness_settings" ADD CONSTRAINT "foreman_harness_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

