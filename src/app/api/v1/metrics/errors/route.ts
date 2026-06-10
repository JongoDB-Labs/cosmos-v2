import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getIpAddress } from "@/lib/api-helpers";

const errorSchema = z.object({
  message: z.string().max(2000),
  name: z.string().max(200).nullish(),
  stack: z.string().max(8000).nullish(),
  digest: z.string().max(200).nullish(),
  scope: z.string().max(64).nullish(),
  url: z.string().max(2000).nullish(),
  userAgent: z.string().max(500).nullish(),
  appVersion: z.string().max(40).nullish(),
  viewport: z.string().max(20).nullish(),
  breadcrumbs: z.array(z.string().max(320)).max(15).nullish(),
  ts: z.number().optional(),
});

/**
 * Client-side error sink. Logged to stdout so production log aggregators
 * (or a future Sentry integration) can index them. Intentionally permissive
 * — no auth required because errors from logged-out pages still matter.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = errorSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    const ip = getIpAddress(request);
    console.error(
      `[client:error] scope=${parsed.data.scope ?? "?"} v=${parsed.data.appVersion ?? "?"} ` +
        `vp=${parsed.data.viewport ?? "?"} ip=${ip ?? "?"} ` +
        `url=${parsed.data.url ?? "?"} msg=${parsed.data.message}`,
      parsed.data.breadcrumbs?.length
        ? `\n  trail: ${parsed.data.breadcrumbs.join(" | ")}`
        : "",
      parsed.data.stack ?? "",
    );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
