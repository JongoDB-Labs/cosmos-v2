import { prisma } from "./client";

export async function withTenant<T>(
  orgId: string,
  callback: (tx: typeof prisma) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_org_id = '${orgId}'`
    );
    return callback(tx as unknown as typeof prisma);
  });
}

export async function withBypassRls<T>(
  callback: (tx: typeof prisma) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'true'`);
    return callback(tx as unknown as typeof prisma);
  });
}
