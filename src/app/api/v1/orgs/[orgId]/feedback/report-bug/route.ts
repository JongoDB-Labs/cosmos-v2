import { NextRequest } from "next/server";
import { z } from "zod";
import { FeedbackType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { projectKeyFromRoute } from "@/lib/feedback/route-project";

type RouteParams = { params: Promise<{ orgId: string }> };

const reportSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  route: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  componentStack: z.string().max(8000).optional(),
  digest: z.string().max(120).optional(),
  // Richer telemetry: which build the error hit, the viewport at the time, and
  // a short trail of the console messages leading up to it (capped for safety).
  appVersion: z.string().max(40).optional(),
  viewport: z.string().max(20).optional(),
  breadcrumbs: z.array(z.string().max(320)).max(15).optional(),
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
      appVersion: data.appVersion ?? null,
      viewport: data.viewport ?? null,
      breadcrumbs: data.breadcrumbs ?? null,
      capturedAt: now.toISOString(),
    };

    // Dedup: reuse an existing BUG with the same signature so repeated crashes
    // don't spawn duplicate items. On a repeat we append a sighting + bump the
    // hit count (append-only telemetry history → repeat-frequency for triage).
    //
    // The findFirst→create pair is a check-then-act with no DB-level uniqueness
    // backstop, so two concurrent identical-signature POSTs (e.g. the same crash
    // firing in two browser tabs) could each see "no existing row" and BOTH
    // insert — diverging hit counts across duplicate items. Serialize them with
    // a transaction-scoped advisory lock keyed on (orgId, title): identical
    // signatures contend and run one-at-a-time, distinct ones never block.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}), hashtext(${title}))`;

      const existing = await tx.feedbackItem.findFirst({
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
          // Latest-occurrence quick-triage fields (full history in `sightings`).
          appVersion: sighting.appVersion,
          viewport: sighting.viewport,
          breadcrumbs: sighting.breadcrumbs,
          // Keep the most recent 20 sightings.
          sightings: [...(Array.isArray(prev.sightings) ? prev.sightings : []), sighting].slice(-20),
        };
        await tx.feedbackItem.update({
          where: { id: existing.id },
          data: { telemetry: telemetry as Prisma.InputJsonValue },
        });
        return { id: existing.id, title, deduped: true };
      }

      // Tag the new item with the project its route belongs to (org-scoped,
      // live projects only) so triage (A5) routes it there instead of falling
      // back to the org default. A route that matches no project in this org
      // is app-level, not an error — projectId just stays null.
      const projectKey = projectKeyFromRoute(data.route);
      const routedProject = projectKey
        ? await tx.project.findFirst({ where: { orgId, key: projectKey, archived: false }, select: { id: true } })
        : null;

      const description = [
        data.route ? `**Where:** \`${data.route}\`` : null,
        data.appVersion ? `**Version:** \`${data.appVersion}\`${data.viewport ? ` · **Viewport:** \`${data.viewport}\`` : ""}` : null,
        `**Error:** ${data.message.slice(0, 2000)}`,
        data.digest ? `**Ref:** \`${data.digest}\`` : null,
        data.userAgent ? `**Browser:** ${data.userAgent.slice(0, 300)}` : null,
        data.breadcrumbs?.length
          ? `**Leading up to it:**\n\n\`\`\`\n${data.breadcrumbs.join("\n").slice(0, 2000)}\n\`\`\``
          : null,
        data.componentStack
          ? `**Component stack:**\n\n\`\`\`\n${data.componentStack.slice(0, 3000)}\n\`\`\``
          : null,
        data.stack ? `**Stack:**\n\n\`\`\`\n${data.stack.slice(0, 4000)}\n\`\`\`` : null,
        `_Auto-captured from a client error and reported by a member._`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const created = await tx.feedbackItem.create({
        data: {
          orgId,
          authorId: ctx.userId,
          type: FeedbackType.BUG,
          title,
          description,
          projectId: routedProject?.id ?? null,
          telemetry: {
            errorSignature: sig,
            hits: 1,
            firstSeen: now.toISOString(),
            lastSeen: now.toISOString(),
            route: sighting.route,
            userAgent: sighting.userAgent,
            appVersion: sighting.appVersion,
            viewport: sighting.viewport,
            breadcrumbs: sighting.breadcrumbs,
            stack: data.stack?.slice(0, 4000) ?? null,
            componentStack: data.componentStack?.slice(0, 3000) ?? null,
            sightings: [sighting],
          } as Prisma.InputJsonValue,
        },
        select: { id: true, title: true },
      });

      return { ...created, deduped: false };
    });

    return success(result);
  } catch (e) {
    return handleApiError(e);
  }
}
