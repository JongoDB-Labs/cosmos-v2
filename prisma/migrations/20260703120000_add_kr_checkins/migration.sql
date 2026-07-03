-- OKR redesign P1: key-result check-ins (the time-series for RAG/confidence over
-- time) + denormalized latest confidence/rag on key_results. Purely additive.

-- CreateEnum
CREATE TYPE "RagStatus" AS ENUM ('GREEN', 'YELLOW', 'RED');

-- AlterTable: latest-check-in snapshot on the key result (null until first check-in)
ALTER TABLE "key_results" ADD COLUMN "confidence" INTEGER;
ALTER TABLE "key_results" ADD COLUMN "rag" "RagStatus";

-- CreateTable
CREATE TABLE "key_result_checkins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key_result_id" UUID NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 50,
    "rag" "RagStatus" NOT NULL,
    "note" TEXT,
    "blockers" TEXT,
    "checked_in_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_result_checkins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "key_result_checkins_key_result_id_created_at_idx" ON "key_result_checkins"("key_result_id", "created_at");

-- AddForeignKey
ALTER TABLE "key_result_checkins" ADD CONSTRAINT "key_result_checkins_key_result_id_fkey" FOREIGN KEY ("key_result_id") REFERENCES "key_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;
