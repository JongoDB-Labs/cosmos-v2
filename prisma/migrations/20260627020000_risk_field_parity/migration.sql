-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RiskStatus" ADD VALUE 'MONITORING';
ALTER TYPE "RiskStatus" ADD VALUE 'MITIGATED';
ALTER TYPE "RiskStatus" ADD VALUE 'ESCALATED';

-- AlterTable
ALTER TABLE "risks" ADD COLUMN     "contingency" TEXT,
ADD COLUMN     "date_identified" TIMESTAMP(3);

