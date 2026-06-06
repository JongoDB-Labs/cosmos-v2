import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getGmailClient } from "@/lib/integrations/google";
import { success, handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";

// cacheComponents enabled: `runtime` segment config not supported (Node is default).

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    // Gmail search is heavier than calendar/drive — cap tighter.
    const limited = checkRateLimit(request, "google.gmail.get", user.id, {
      capacity: 30,
      refillPerSecond: 0.5,
    });
    if (limited) return limited;

    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    if (!q) return new Response("Missing q param", { status: 400 });

    const maxResults = Math.min(
      parseInt(url.searchParams.get("maxResults") ?? "20", 10),
      100,
    );

    try {
      const gmail = await getGmailClient(user.id);
      const list = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults,
      });
      const messageIds = list.data.messages ?? [];

      // Fetch headers for each — limit to first 20 to control rate
      const headerLimited = messageIds.slice(0, 20);
      const messages = await Promise.all(
        headerLimited.map(async (m) => {
          if (!m.id) return null;
          const msg = await gmail.users.messages.get({
            userId: "me",
            id: m.id,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          });
          return {
            id: msg.data.id,
            threadId: msg.data.threadId,
            snippet: msg.data.snippet,
            headers: msg.data.payload?.headers ?? [],
          };
        }),
      );

      return success({ messages: messages.filter(Boolean) });
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
