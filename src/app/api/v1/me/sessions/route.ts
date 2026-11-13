import { getCurrentUser } from "@/lib/auth/session";
import { sessionHandle } from "@/lib/auth/session-handle";
import { prisma } from "@/lib/db/client";
import { success, handleApiError } from "@/lib/api-helpers";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const sessions = await prisma.session.findMany({
      where: {
        userId: user.id,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    });

    // `id` is a handle, not the session id: the session id is the sign-in
    // cookie's value. DELETE /me/sessions/{id} takes the handle.
    const payload = sessions.map((s) => ({
      id: sessionHandle(s.id),
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      userAgent: null as string | null,
      ipAddress: null as string | null,
      isCurrent: s.id === user.sessionId,
    }));

    return success(payload);
  } catch (e) {
    return handleApiError(e);
  }
}
