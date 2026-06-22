import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { imageUrlSchema } from "@/lib/security/image-url";

const schema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  // ~1MB image as base64 (expands ~34%) plus the data-URL prefix. The client
  // downscales large photos to fit, so this is just a safety ceiling.
  avatarUrl: imageUrlSchema(1_400_000, "Must be a data-URL image (~1MB max) or an https URL"),
});

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const full = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        createdAt: true,
        preferences: {
          select: {
            bgDarkUrl: true,
            bgLightUrl: true,
          },
        },
      },
    });
    if (!full) return new Response("Not found", { status: 404 });

    return success(full);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const body = schema.parse(await request.json());
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
      },
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}
