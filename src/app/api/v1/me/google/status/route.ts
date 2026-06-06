import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { hasUserCredential } from "@/lib/integrations/credentials";

export async function GET(_request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });
    // The sealed connector credential store is the sole source of truth for the
    // Google grant (the plaintext User.googleRefreshToken column was dropped in
    // v2.12.0). Presence check only — we never open the sealed secret here.
    const connected = await hasUserCredential("google", user.id);
    return success({ connected });
  } catch (error) {
    return handleApiError(error);
  }
}
