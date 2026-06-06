import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const vitalSchema = z.object({
  // Covers Core Web Vitals (LCP, CLS, …) AND Next.js custom metrics like
  // "Next.js-route-change-to-render" (30 chars) — the old max(16) rejected the
  // latter, producing a 400 on every navigation.
  name: z.string().max(64),
  id: z.string().max(200),
  value: z.number(),
  rating: z.string().max(16).nullish(),
  delta: z.number().optional(),
  navigationType: z.string().max(64).nullish(),
  url: z.string().max(2000).nullish(),
  ts: z.number().optional(),
});

/**
 * Core Web Vitals ingestion. Stays log-only for now; a later commit can
 * persist these to a `WebVital` table or pipe them to a real OTLP/Sentry
 * sink. Permissive auth — vitals on logged-out routes still matter.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = vitalSchema.safeParse(body);
    // Fire-and-forget telemetry: always answer 204 so a malformed or partial
    // beacon (sendBeacon bodies can arrive truncated as the page unloads)
    // never surfaces a "Failed to load resource: 400" in the user's console.
    // We simply don't record what we can't parse.
    if (!parsed.success) {
      return new NextResponse(null, { status: 204 });
    }
    const { name, value, rating, url } = parsed.data;
    console.log(
      `[vitals] ${name}=${value.toFixed(1)}${rating ? ` rating=${rating}` : ""} url=${url ?? "?"}`,
    );
    return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
