import { getCurrentUser } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { sealSecret } from "@/lib/crypto/vault";
import { initiateUserClaudeOAuth } from "@/lib/ai/user-claude-subscription";

/**
 * Begin the PER-USER Claude-subscription OAuth (PKCE). Mints verifier + state,
 * stashes them SEALED in a short-lived httpOnly cookie the exchange route
 * validates, and returns the Claude authorize URL. Gated only on being signed
 * in — this connects the CALLER's own personal Claude account, not the org's.
 */

const PKCE_COOKIE = "claude_user_oauth_pkce";
const PKCE_COOKIE_MAX_AGE = 600; // 10 minutes

export async function POST() {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const { url, verifier, state } = initiateUserClaudeOAuth();

    const response = success({ url });
    response.cookies.set(
      PKCE_COOKIE,
      sealSecret(JSON.stringify({ verifier, state })),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: PKCE_COOKIE_MAX_AGE,
      },
    );
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
