import type { NextResponse } from "next/server";

/**
 * Non-httpOnly cookie remembering the last org a user signed into, so the
 * /login page can render that org's brand + skin before authentication. It
 * carries only a public org slug (never a secret), so JS-readable is fine and
 * intentional (the login page reads it client-side).
 */
export const REMEMBERED_ORG_COOKIE = "org";

export function setRememberedOrgCookie(res: NextResponse, slug: string): void {
  if (!slug) return;
  res.cookies.set(REMEMBERED_ORG_COOKIE, slug, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === "production",
  });
}
