import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";

/**
 * Test-only email → userId lookup. Disabled unless E2E_TEST_AUTH === "1".
 * Used by Playwright fixtures to construct <@uuid> mention tokens.
 *
 * GET /api/__test__/user-id?email=alice%40test.local
 * Returns: { userId: string }
 */
export async function GET(req: NextRequest) {
  if (process.env.E2E_TEST_AUTH !== "1") {
    return new Response("Disabled", { status: 404 });
  }
  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  if (!email) return new Response("Bad Request", { status: 400 });
  const user = await prisma.user.findFirst({
    where: { email },
    select: { id: true },
  });
  if (!user) return new Response("Not Found", { status: 404 });
  return new Response(JSON.stringify({ userId: user.id }), {
    headers: { "content-type": "application/json" },
  });
}
