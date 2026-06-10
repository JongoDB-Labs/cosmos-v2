import { getCurrentUser } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { disconnectUserClaude } from "@/lib/ai/user-claude-subscription";

/** Disconnect the CALLER's personal Claude subscription (the agent then falls
 *  back to the org credential). Signed-in users only. */
export async function POST() {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    await disconnectUserClaude(user.id);
    return success({ success: true });
  } catch (error) {
    return handleApiError(error);
  }
}
