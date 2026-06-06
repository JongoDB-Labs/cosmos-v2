import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { getVapidPublicKey } from "@/lib/notifications/push";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";

const schema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export async function GET() {
  try {
    return success({ publicKey: getVapidPublicKey() });
  } catch (e) {
    if (e instanceof Error && e.message.includes("VAPID_PUBLIC_KEY")) {
      return new Response(JSON.stringify({ error: "push_not_configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    // 30 subscribes / 5 min per user — generous for legitimate device-add
    // flows while blocking endpoint-spam attempts.
    const rl = rateLimit(getRateLimitKey(request, "push.subscribe", user.id), {
      capacity: 30,
      refillPerSecond: 0.1,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
      );
    }

    const body = schema.parse(await request.json());
    const userAgent = request.headers.get("user-agent") ?? null;

    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: {
        userId: user.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent,
      },
      update: {
        userId: user.id,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent,
        lastUsedAt: new Date(),
      },
    });

    return success({ id: sub.id });
  } catch (e) {
    return handleApiError(e);
  }
}
