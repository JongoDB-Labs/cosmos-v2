import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { prisma } from "@/lib/db/client";
import { noContent, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ sessionId: string }> };

export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const { sessionId } = await params;

    const cookieStore = await cookies();
    const currentSessionId = cookieStore.get(SESSION_COOKIE)?.value ?? null;

    if (sessionId === currentSessionId) {
      return new Response(
        JSON.stringify({
          error: "Cannot revoke your current session — use logout",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.userId !== user.id) {
      return new Response("Not found", { status: 404 });
    }

    await prisma.session.delete({ where: { id: sessionId } });

    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
