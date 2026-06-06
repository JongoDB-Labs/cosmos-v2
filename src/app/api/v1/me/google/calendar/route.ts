import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getCalendarClient } from "@/lib/integrations/google";
import { success, handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";

// cacheComponents enabled: `runtime` segment config not supported (Node is default).

const CAL_LIMIT = { capacity: 60, refillPerSecond: 1 };

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const limited = checkRateLimit(request, "google.cal.get", user.id, CAL_LIMIT);
    if (limited) return limited;

    const url = new URL(request.url);
    const timeMin = url.searchParams.get("timeMin") ?? new Date().toISOString();
    const timeMax =
      url.searchParams.get("timeMax") ??
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const maxResults = Math.min(
      parseInt(url.searchParams.get("maxResults") ?? "50", 10),
      250,
    );

    try {
      const cal = await getCalendarClient(user.id);
      const events = await cal.events.list({
        calendarId: "primary",
        timeMin,
        timeMax,
        maxResults,
        singleEvents: true,
        orderBy: "startTime",
      });
      return success({ events: events.data.items ?? [] });
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

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const limited = checkRateLimit(
      request,
      "google.cal.post",
      user.id,
      { capacity: 30, refillPerSecond: 0.5 },
    );
    if (limited) return limited;

    type EventBody = {
      summary?: string;
      description?: string;
      start?: { dateTime?: string; date?: string; timeZone?: string };
      end?: { dateTime?: string; date?: string; timeZone?: string };
      attendees?: { email: string }[];
      location?: string;
    };
    const body = (await request.json()) as EventBody;

    try {
      const cal = await getCalendarClient(user.id);
      const event = await cal.events.insert({
        calendarId: "primary",
        requestBody: body,
      });
      return success({ event: event.data });
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
