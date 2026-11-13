import type { NextRequest } from "next/server";
import { OAUTH_STATE_COOKIE } from "@/lib/auth/client";
import { googleSignInUrl } from "@/lib/auth/google-oauth";
import { startConnect } from "@/lib/auth/connect-flow";

/** Connect Google to the signed-in account (Profile, Sign-in methods). */
export async function POST(request: NextRequest) {
  return startConnect(request, "google", {
    stateCookie: OAUTH_STATE_COOKIE,
    authorizeUrl: (state) => googleSignInUrl(request, state),
  });
}
