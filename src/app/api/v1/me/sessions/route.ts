import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { prisma } from "@/lib/db/client";
import { success, handleApiError } from "@/lib/api-helpers";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const cookieStore = await cookies();
    const currentSessionId = cookieStore.get(SESSION_COOKIE)?.value ?? null;

    const sessions = await prisma.session.findMany({
      where: {
        userId: user.id,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    const payload = sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      userAgent: null as string | null,
      ipAddress: null as string | null,
      isCurrent: s.id === currentSessionId,
    }));

    return success(payload);
  } catch (e) {
    return handleApiError(e);
  }
}
