-- CreateTable
CREATE TABLE "work_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "grants" BIGINT NOT NULL DEFAULT 0,
    "policies" JSONB NOT NULL DEFAULT '[]',
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_member_work_roles" (
    "org_member_id" UUID NOT NULL,
    "work_role_id" UUID NOT NULL,
    "scope" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_member_work_roles_pkey" PRIMARY KEY ("org_member_id","work_role_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_roles_org_id_key_key" ON "work_roles"("org_id", "key");

-- CreateIndex
CREATE INDEX "org_member_work_roles_work_role_id_idx" ON "org_member_work_roles"("work_role_id");

-- AddForeignKey
ALTER TABLE "work_roles" ADD CONSTRAINT "work_roles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member_work_roles" ADD CONSTRAINT "org_member_work_roles_org_member_id_fkey" FOREIGN KEY ("org_member_id") REFERENCES "org_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member_work_roles" ADD CONSTRAINT "org_member_work_roles_work_role_id_fkey" FOREIGN KEY ("work_role_id") REFERENCES "work_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

