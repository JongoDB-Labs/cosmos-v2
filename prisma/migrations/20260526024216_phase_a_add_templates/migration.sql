-- CreateEnum
CREATE TYPE "CycleKind" AS ENUM ('SPRINT', 'PHASE', 'MODULE', 'RUN', 'EVENT_DAY', 'RELEASE', 'ITERATION');

-- AlterTable
ALTER TABLE "board_templates" ADD COLUMN     "project_template_id" UUID,
ADD COLUMN     "sector" TEXT,
ADD COLUMN     "source_template_id" UUID;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "enabled_features" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "project_template_id" UUID;

-- AlterTable
ALTER TABLE "work_items" ADD COLUMN     "cycle_id" UUID,
ADD COLUMN     "work_item_type_id" UUID;

-- CreateTable
CREATE TABLE "project_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID,
    "slug" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "thumbnail_url" TEXT,
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "default_config" JSONB NOT NULL DEFAULT '{}',
    "source_template_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID,
    "project_template_id" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plural_name" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "default_parent_type_key" TEXT,
    "celebrate_on_complete" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_type_fields" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "work_item_type_id" UUID NOT NULL,
    "custom_field_id" UUID NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "work_item_type_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "cycle_kind" "CycleKind" NOT NULL DEFAULT 'SPRINT',
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sector_label" TEXT,
    "goal" TEXT NOT NULL DEFAULT '',
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" "SprintStatus" NOT NULL DEFAULT 'PLANNED',
    "report" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycle_capacities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cycle_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "capacity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cycle_capacities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_templates_org_id_slug_key" ON "project_templates"("org_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_types_org_id_key_key" ON "work_item_types"("org_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_type_fields_work_item_type_id_custom_field_id_key" ON "work_item_type_fields"("work_item_type_id", "custom_field_id");

-- CreateIndex
CREATE UNIQUE INDEX "cycles_project_id_number_key" ON "cycles"("project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "cycle_capacities_cycle_id_user_id_key" ON "cycle_capacities"("cycle_id", "user_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_project_template_id_fkey" FOREIGN KEY ("project_template_id") REFERENCES "project_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_work_item_type_id_fkey" FOREIGN KEY ("work_item_type_id") REFERENCES "work_item_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_templates" ADD CONSTRAINT "board_templates_project_template_id_fkey" FOREIGN KEY ("project_template_id") REFERENCES "project_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_templates" ADD CONSTRAINT "board_templates_source_template_id_fkey" FOREIGN KEY ("source_template_id") REFERENCES "board_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_source_template_id_fkey" FOREIGN KEY ("source_template_id") REFERENCES "project_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_types" ADD CONSTRAINT "work_item_types_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_types" ADD CONSTRAINT "work_item_types_project_template_id_fkey" FOREIGN KEY ("project_template_id") REFERENCES "project_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_type_fields" ADD CONSTRAINT "work_item_type_fields_work_item_type_id_fkey" FOREIGN KEY ("work_item_type_id") REFERENCES "work_item_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_type_fields" ADD CONSTRAINT "work_item_type_fields_custom_field_id_fkey" FOREIGN KEY ("custom_field_id") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_capacities" ADD CONSTRAINT "cycle_capacities_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_capacities" ADD CONSTRAINT "cycle_capacities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
