-- Gantt enhancements (FR gantt-enh): frozen baseline dates (slippage) + SAFe
-- Business/Enabler work classification on work items.

-- CreateEnum
CREATE TYPE "WorkCategory" AS ENUM ('BUSINESS', 'ENABLER');

-- AlterTable
ALTER TABLE "work_items" ADD COLUMN     "baseline_end" TIMESTAMP(3),
ADD COLUMN     "baseline_start" TIMESTAMP(3),
ADD COLUMN     "work_category" "WorkCategory" NOT NULL DEFAULT 'BUSINESS';
