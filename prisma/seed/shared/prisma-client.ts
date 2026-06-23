import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Build a PrismaClient for the seed / CLI scripts.
 *
 * Prisma 7 requires a driver adapter — the connection URL no longer lives in
 * schema.prisma (see prisma.config.ts), so `new PrismaClient()` / the old
 * `{ datasourceUrl }` option can no longer carry it. PrismaPg opens a node-postgres
 * pool. Pass an explicit connection string to target a specific database; otherwise
 * it falls back to DATABASE_URL — reproducing the previous
 * `new PrismaClient(url ? { datasourceUrl: url } : undefined)` behaviour.
 */
export function makePrismaClient(connectionString?: string) {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: connectionString || process.env.DATABASE_URL,
    }),
  });
}
