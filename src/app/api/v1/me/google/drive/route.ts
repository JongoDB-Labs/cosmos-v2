import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getDriveClient } from "@/lib/integrations/google";
import { success, handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";

// cacheComponents enabled: `runtime` segment config not supported (Node is default).

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const limited = checkRateLimit(request, "google.drive.get", user.id, {
      capacity: 60,
      refillPerSecond: 1,
    });
    if (limited) return limited;

    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? undefined;
    const pageSize = Math.min(
      parseInt(url.searchParams.get("pageSize") ?? "50", 10),
      200,
    );
    const pageToken = url.searchParams.get("pageToken") ?? undefined;

    try {
      const drive = await getDriveClient(user.id);
      const files = await drive.files.list({
        q,
        pageSize,
        pageToken,
        fields:
          "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, iconLink, size)",
        orderBy: "modifiedTime desc",
      });
      return success({
        files: files.data.files ?? [],
        nextPageToken: files.data.nextPageToken ?? null,
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes("Google not connected")) {
        return new Response(JSON.stringify({ error: "google_not_connected" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw e;
    }
  } catch (e) {
    return handleApiError(e);
  }
}
