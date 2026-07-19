-- CreateTable
CREATE TABLE "foreman_supervisor_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'dry',
    "deliver_close" BOOLEAN NOT NULL DEFAULT true,
    "requeue" BOOLEAN NOT NULL DEFAULT true,
    "dedup" BOOLEAN NOT NULL DEFAULT true,
    "escalate" BOOLEAN NOT NULL DEFAULT true,
    "confidence_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "per_pass_cap" INTEGER NOT NULL DEFAULT 5,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "foreman_supervisor_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "foreman_supervisor_settings_org_id_key" ON "foreman_supervisor_settings"("org_id");

-- AddForeignKey
ALTER TABLE "foreman_supervisor_settings" ADD CONSTRAINT "foreman_supervisor_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

