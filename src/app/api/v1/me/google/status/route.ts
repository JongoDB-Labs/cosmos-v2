import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";

export async function GET(_request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { googleRefreshToken: true },
    });
    return success({ connected: Boolean(row?.googleRefreshToken) });
  } catch (error) {
    return handleApiError(error);
  }
}
