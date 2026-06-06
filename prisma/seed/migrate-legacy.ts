import type { PrismaClient } from "@prisma/client";

/**
 * Legacy migration — Sprint / Objective / KeyResult models have been dropped
 * in Phase C. This function is now a no-op but kept for seed script
 * compatibility. The data migration was completed before the models were removed.
 */
export async function migrateLegacyData(_prisma: PrismaClient) {
  console.log("  Legacy migration: Sprint/Objective/KeyResult models dropped — nothing to migrate");
}
