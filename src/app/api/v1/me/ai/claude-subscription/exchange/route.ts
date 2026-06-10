import { NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { openSecret } from "@/lib/crypto/vault";
import { exchangeUserClaudeCode } from "@/lib/ai/user-claude-subscription";

/**
 * Complete the PER-USER Claude-subscription OAuth: read the sealed PKCE cookie,
 * exchange the pasted code/URL for tokens, seal + store them on the user's
 * UserAiSettings row, then delete the one-shot cookie. Signed-in users only.
 */

const PKCE_COOKIE = "claude_user_oauth_pkce";

const bodySchema = z.object({ code: z.string().min(1).max(8192) }).strict();

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const { code } = bodySchema.parse(await request.json());

    const pkceCookie = request.cookies.get(PKCE_COOKIE);
    if (!pkceCookie?.value) {
      return success({
        success: false,
        error: "OAuth session expired. Please start again.",
      });
    }

    let verifier: string;
    let state: string;
    try {
      const pkce = JSON.parse(openSecret(pkceCookie.value)) as {
        verifier: string;
        state: string;
      };
      verifier = pkce.verifier;
      state = pkce.state;
    } catch {
      const bad = success({
        success: false,
        error: "Invalid OAuth session. Please start again.",
      });
      bad.cookies.delete(PKCE_COOKIE);
      return bad;
    }

    const result = await exchangeUserClaudeCode(user.id, code, verifier, state);

    const response = success(result);
    response.cookies.delete(PKCE_COOKIE);
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
