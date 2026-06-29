-- AlterTable
ALTER TABLE "project_members" ADD COLUMN     "access_status" TEXT,
ADD COLUMN     "cac_expiry" TIMESTAMP(3),
ADD COLUMN     "cac_status" TEXT,
ADD COLUMN     "compliance_notes" TEXT,
ADD COLUMN     "nda_status" TEXT,
ADD COLUMN     "on_contract" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "training_status" TEXT;

