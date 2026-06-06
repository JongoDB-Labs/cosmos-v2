import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";

const schema = z.object({
  endpoint: z.string().url(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const body = schema.parse(await request.json());

    const result = await prisma.pushSubscription.deleteMany({
      where: { userId: user.id, endpoint: body.endpoint },
    });

    return success({ deleted: result.count });
  } catch (e) {
    return handleApiError(e);
  }
}
