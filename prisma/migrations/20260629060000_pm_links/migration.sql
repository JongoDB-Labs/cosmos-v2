-- CreateTable
CREATE TABLE "pm_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "from_type" TEXT NOT NULL,
    "from_id" UUID NOT NULL,
    "to_type" TEXT NOT NULL,
    "to_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pm_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pm_links_org_id_from_type_from_id_idx" ON "pm_links"("org_id", "from_type", "from_id");

-- CreateIndex
CREATE INDEX "pm_links_org_id_to_type_to_id_idx" ON "pm_links"("org_id", "to_type", "to_id");

-- CreateIndex
CREATE UNIQUE INDEX "pm_links_from_type_from_id_to_type_to_id_key" ON "pm_links"("from_type", "from_id", "to_type", "to_id");

