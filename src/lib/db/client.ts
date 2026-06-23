import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma 7 requires a driver adapter: the connection URL is no longer embedded in the
// generated client (it left schema.prisma — see prisma.config.ts). PrismaPg builds a
// node-postgres pool from DATABASE_URL, the same env var the v6 client resolved via the
// schema's `env("DATABASE_URL")`, so runtime connection behavior is unchanged.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
