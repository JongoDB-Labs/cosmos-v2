import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import {
  MAX_TAG_NAME_LEN,
  MAX_TAGS,
  normalizeColor,
  normalizeTagName,
  readTagRegistry,
  removeTagDef,
  upsertTagDef,
  type TagDef,
} from "@/lib/work-items/tags";

/**
 * Managed tag vocabulary for an org (COSMOS-93). Backed by
 * `Organization.settings.tags` (see lib/work-items/tags.ts) rather than a new
 * table — it curates the existing free-form `WorkItem.tags` strings.
 *
 *   GET    → list the org's tags
 *   POST   → create a tag, or recolor an existing one   (ITEM_UPDATE)
 *   DELETE → delete a tag (?name=…) AND strip it from every work item (ITEM_UPDATE)
 */

type RouteParams = { params: Promise<{ orgId: string }> };

const upsertSchema = z.object({
  name: z.string().min(1).max(MAX_TAG_NAME_LEN),
  // Optional: a hex color, or null/omitted for an uncolored tag.
  color: z.string().max(9).nullish(),
});

function badRequest(error: string) {
  return new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/** Merge the tag registry back into `Organization.settings` without touching
 *  other settings keys (mirrors the feedback-automation config write). */
async function persistTags(orgId: string, existing: unknown, tags: TagDef[]) {
  const root = (existing as Record<string, unknown>) ?? {};
  await prisma.organization.update({
    where: { id: orgId },
    data: { settings: { ...root, tags } as never },
  });
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, settings: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_READ);

    return success(readTagRegistry(org.settings));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, settings: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_UPDATE);

    const data = upsertSchema.parse(await request.json());
    const name = normalizeTagName(data.name);
    if (!name) return badRequest("Tag name is required.");
    // A provided-but-malformed color is a client error; absent/empty is fine.
    const color = normalizeColor(data.color);
    if (data.color != null && data.color !== "" && color === null) {
      return badRequest("Color must be a hex value like #ef4444.");
    }

    const registry = readTagRegistry(org.settings);
    const exists = registry.some((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!exists && registry.length >= MAX_TAGS) {
      return badRequest(`You can define at most ${MAX_TAGS} tags.`);
    }

    const next = upsertTagDef(registry, { name, color });
    await persistTags(orgId, org.settings, next);

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: exists ? "tag.updated" : "tag.created",
      entity: "tag",
      entityId: name,
      metadata: { name, color },
      ipAddress: getIpAddress(request),
    });

    return success(next);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, settings: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_UPDATE);

    const name = normalizeTagName(request.nextUrl.searchParams.get("name"));
    if (!name) return badRequest("Tag name is required.");

    const next = removeTagDef(readTagRegistry(org.settings), name);

    // Strip the tag from every work item in the org that carries it — one
    // statement, no per-row loop. `array_remove` drops all exact matches.
    const stripped = await prisma.$executeRaw`
      UPDATE work_items
         SET tags = array_remove(tags, ${name})
       WHERE org_id = ${orgId}::uuid
         AND ${name} = ANY(tags)`;

    await persistTags(orgId, org.settings, next);

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "tag.deleted",
      entity: "tag",
      entityId: name,
      metadata: { name, itemsUpdated: stripped },
      ipAddress: getIpAddress(request),
    });

    return success(next);
  } catch (error) {
    return handleApiError(error);
  }
}
