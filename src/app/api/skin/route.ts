import { NextRequest, NextResponse } from "next/server";
import { SKIN_COOKIE, isValidSkinId } from "@/lib/theme/cookie";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { skin?: unknown };
  const skin = body.skin;
  const response = NextResponse.json({ ok: true });
  if (skin === null || skin === undefined) {
    response.cookies.delete(SKIN_COOKIE);
    return response;
  }
  if (!isValidSkinId(skin)) {
    return NextResponse.json({ error: "invalid skin" }, { status: 400 });
  }
  response.cookies.set(SKIN_COOKIE, skin, {
    httpOnly: false, sameSite: "lax", path: "/",
    maxAge: 60 * 60 * 24 * 365, secure: process.env.NODE_ENV === "production",
  });
  return response;
}
