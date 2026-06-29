-- CreateEnum
CREATE TYPE "KpiAutoSource" AS ENUM ('MANUAL', 'VELOCITY', 'COMPLETION_PCT', 'THROUGHPUT', 'OPEN_ITEMS', 'AVG_CYCLE_TIME');

-- AlterTable
ALTER TABLE "kpis" ADD COLUMN     "auto_source" "KpiAutoSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "auto_window_days" INTEGER;

