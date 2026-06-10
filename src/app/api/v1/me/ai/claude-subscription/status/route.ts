import { getCurrentUser } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { getUserClaudeSubscriptionStatus } from "@/lib/ai/user-claude-subscription";

/** Connection status for the CALLER's personal Claude subscription. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const status = await getUserClaudeSubscriptionStatus(user.id);
    return success(status);
  } catch (error) {
    return handleApiError(error);
  }
}
