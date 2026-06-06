/*
  Warnings:

  - You are about to drop the column `methodology` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `sprint_id` on the `work_items` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `work_items` table. All the data in the column will be lost.
  - You are about to drop the `key_results` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `objectives` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `sprint_capacities` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `sprints` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `work_item_type_id` on table `work_items` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "key_results" DROP CONSTRAINT "key_results_objective_id_fkey";

-- DropForeignKey
ALTER TABLE "sprint_capacities" DROP CONSTRAINT "sprint_capacities_sprint_id_fkey";

-- DropForeignKey
ALTER TABLE "sprint_capacities" DROP CONSTRAINT "sprint_capacities_user_id_fkey";

-- DropForeignKey
ALTER TABLE "sprints" DROP CONSTRAINT "sprints_project_id_fkey";

-- DropForeignKey
ALTER TABLE "work_items" DROP CONSTRAINT "work_items_sprint_id_fkey";

-- DropForeignKey
ALTER TABLE "work_items" DROP CONSTRAINT "work_items_work_item_type_id_fkey";

-- DropIndex
DROP INDEX "work_items_org_id_sprint_id_idx";

-- AlterTable
ALTER TABLE "projects" DROP COLUMN "methodology";

-- AlterTable
ALTER TABLE "work_items" DROP COLUMN "sprint_id",
DROP COLUMN "type",
ALTER COLUMN "work_item_type_id" SET NOT NULL;

-- DropTable
DROP TABLE "key_results";

-- DropTable
DROP TABLE "objectives";

-- DropTable
DROP TABLE "sprint_capacities";

-- DropTable
DROP TABLE "sprints";

-- DropEnum
DROP TYPE "Methodology";

-- DropEnum
DROP TYPE "WorkItemType";

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_work_item_type_id_fkey" FOREIGN KEY ("work_item_type_id") REFERENCES "work_item_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
