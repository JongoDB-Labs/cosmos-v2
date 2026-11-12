import { getCurrentUser } from "@/lib/auth/session";
import { sessionHandle } from "@/lib/auth/session-handle";
import { prisma } from "@/lib/db/client";
import { noContent, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ sessionId: string }> };

/** Revoke one of the caller's own sessions, named by the handle GET lists. */
export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const { sessionId: handle } = await params;

    // Only the caller's own sessions are candidates, so a handle can never
    // reach someone else's.
    const mine = await prisma.session.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    const target = mine.find((s) => sessionHandle(s.id) === handle);
    if (!target) return new Response("Not found", { status: 404 });

    if (target.id === user.sessionId) {
      return new Response(
        JSON.stringify({
          error: "Cannot revoke your current session — use logout",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    await prisma.session.deleteMany({ where: { id: target.id, userId: user.id } });

    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
