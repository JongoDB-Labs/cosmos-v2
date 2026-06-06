import { NextResponse, type NextRequest } from "next/server";
import { isValidThemeMode, THEME_COOKIE } from "@/lib/theme/cookie";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const mode = body?.mode;
  if (!isValidThemeMode(mode)) {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }

  const response = NextResponse.json({ mode });
  response.cookies.set(THEME_COOKIE, mode, {
    httpOnly: false, // client reads this to apply the class immediately
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
