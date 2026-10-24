import { prisma } from "@/lib/db/client";
import { INTERVAL_REQUIRED_MESSAGE, requiresInterval } from "./interval-required";

/**
 * The server-side half: the message to reject with, or null when the create
 * may proceed. A project with no intervals at all is exempt (there is nothing
 * to pick), and so is any other type.
 */
export async function intervalRequirementError(args: {
  projectId: string;
  workItemTypeId: string;
  intervalId: string | null | undefined;
}): Promise<string | null> {
  if (args.intervalId) return null;
  const type = await prisma.workItemType.findUnique({
    where: { id: args.workItemTypeId },
    select: { key: true },
  });
  if (!requiresInterval(type?.key)) return null;
  const intervals = await prisma.interval.count({ where: { projectId: args.projectId } });
  return intervals > 0 ? INTERVAL_REQUIRED_MESSAGE : null;
}
