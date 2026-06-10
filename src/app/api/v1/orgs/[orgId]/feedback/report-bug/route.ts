import { NextRequest } from "next/server";
import { z } from "zod";
import { FeedbackType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

const reportSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  route: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  componentStack: z.string().max(8000).optional(),
  digest: z.string().max(120).optional(),
});

/**
 * Collapse an error message's first line into a stable signature: strip the
 * volatile bits (UUIDs, hex, long numbers) so repeated occurrences of the SAME
 * error group under one title for dedup, while staying human-readable.
 */
function signature(message: string): string {
  return message
    .split("\n")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .trim()
    .slice(0, 160);
}

/**
 * Auto bug-reporting: turn a client-side error into a deduped BUG FeedbackItem,
 * prefilled with the error/route/UA/stack. Any member may file one (ORG_READ),
 * matching the feedback portal's submit gate. Deterministic title (no AI call
 * in the request path) so a broken page can always report reliably; the body
 * carries the full context for triage.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const data = reportSchema.parse(await request.json());
    const sig = signature(data.message);
    const title = `[Bug] ${sig}`;
    const now = new Date();
    const sighting = {
      route: data.route ?? null,
      userAgent: data.userAgent ?? null,
      digest: data.digest ?? null,
      capturedAt: now.toISOString(),
    };

    // Dedup: reuse an existing BUG with the same signature so repeated crashes
    // don't spawn duplicate items. On a repeat we append a sighting + bump the
    // hit count (append-only telemetry history → repeat-frequency for triage).
    const existing = await prisma.feedbackItem.findFirst({
      where: { orgId, type: FeedbackType.BUG, title },
      select: { id: true, telemetry: true },
    });
    if (existing) {
      const prev = (existing.telemetry ?? {}) as {
        hits?: number;
        firstSeen?: string;
        sightings?: unknown[];
      };
      const telemetry = {
        ...prev,
        errorSignature: sig,
        hits: (typeof prev.hits === "number" ? prev.hits : 1) + 1,
        firstSeen: prev.firstSeen ?? now.toISOString(),
        lastSeen: now.toISOString(),
        route: sighting.route,
        userAgent: sighting.userAgent,
        // Keep the most recent 20 sightings.
        sightings: [...(Array.isArray(prev.sightings) ? prev.sightings : []), sighting].slice(-20),
      };
      await prisma.feedbackItem.update({
        where: { id: existing.id },
        data: { telemetry: telemetry as Prisma.InputJsonValue },
      });
      return success({ id: existing.id, title, deduped: true });
    }

    const description = [
      data.route ? `**Where:** \`${data.route}\`` : null,
      `**Error:** ${data.message.slice(0, 2000)}`,
      data.digest ? `**Ref:** \`${data.digest}\`` : null,
      data.userAgent ? `**Browser:** ${data.userAgent.slice(0, 300)}` : null,
      data.componentStack
        ? `**Component stack:**\n\n\`\`\`\n${data.componentStack.slice(0, 3000)}\n\`\`\``
        : null,
      data.stack ? `**Stack:**\n\n\`\`\`\n${data.stack.slice(0, 4000)}\n\`\`\`` : null,
      `_Auto-captured from a client error and reported by a member._`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const created = await prisma.feedbackItem.create({
      data: {
        orgId,
        authorId: ctx.userId,
        type: FeedbackType.BUG,
        title,
        description,
        telemetry: {
          errorSignature: sig,
          hits: 1,
          firstSeen: now.toISOString(),
          lastSeen: now.toISOString(),
          route: sighting.route,
          userAgent: sighting.userAgent,
          stack: data.stack?.slice(0, 4000) ?? null,
          componentStack: data.componentStack?.slice(0, 3000) ?? null,
          sightings: [sighting],
        } as Prisma.InputJsonValue,
      },
      select: { id: true, title: true },
    });

    return success({ ...created, deduped: false });
  } catch (e) {
    return handleApiError(e);
  }
}
