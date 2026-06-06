import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";

const schema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  avatarUrl: z.string()
    // Accept either a data URL (base64) up to 200KB or a regular https URL
    .refine((v) => {
      if (v.startsWith("data:image/")) {
        // Cap data URL at ~200KB raw (base64 expands ~33%, so ~270KB string)
        return v.length <= 280_000;
      }
      try {
        const u = new URL(v);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    }, "Must be a data URL ≤200KB or an https URL")
    .nullable()
    .optional(),
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
