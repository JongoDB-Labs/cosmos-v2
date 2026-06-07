import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { ensureOrgBots } from "@/lib/chat/ensure-bots";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * GET /chat/bots — the org's first-class AI bots as mentionable users + their
 * config.
 *
 * Calls `ensureOrgBots` so the built-ins (assistant/notetaker/answerer/standup)
 * exist and are returned even on a brand-new org (on a migrated org this
 * resolves the rows copied from prod). Returns the SYNTHETIC USER shape the
 * mention picker consumes (id/displayName/email/avatarUrl) plus `isBot: true`
 * AND the config fields (key/persona/model/toolScope/enabledMcp/scheduleCron) so
 * an admin surface can render + edit them. Bots are intentionally NOT OrgMembers
 * — they only author messages + appear in the @-mention typeahead — so they're
 * served from here, not /members.
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const bots = await ensureOrgBots(orgId);
    const list = Object.values(bots).map((b) => ({
      id: b.user.id,
      botId: b.id,
      displayName: b.user.displayName,
      key: b.key,
      persona: b.persona,
      model: b.model,
      toolScope: b.toolScope,
      enabledMcp: b.enabledMcp,
      scheduleCron: b.scheduleCron,
      email: "",
      avatarUrl: null as string | null,
      isBot: true as const,
    }));
    return success(list);
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z.object({
  key: z.enum(["assistant", "notetaker", "answerer", "standup"]),
  persona: z.string().max(2000).optional(),
  model: z.enum(["sonnet", "opus", "haiku"]).optional(),
  toolScope: z.enum(["NONE", "READONLY", "FULL"]).optional(),
  // enabledMcp is intentionally NOT settable here: v2 has no per-bot MCP path
  // wired, and a gov tenant must keep it OFF. It round-trips from prod via the
  // cutover but is not an admin toggle in v2 (TODO(roadmap): per-bot MCP).
});

/**
 * PATCH /chat/bots — update a built-in bot's config (persona / model /
 * toolScope). Requires ORG_MANAGE_SETTINGS. Ensures the bot exists first, then
 * updates by (orgId, key). Returns the updated config row.
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!hasPermission(ctx.permissions, Permission.ORG_MANAGE_SETTINGS)) {
      return new Response("Forbidden", { status: 403 });
    }

    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) return new Response("Bad request", { status: 400 });

    // Ensure the built-ins exist (idempotent), then update the addressed one.
    await ensureOrgBots(orgId);
    const { key, ...rest } = parsed.data;
    const updated = await prisma.chatBot.update({
      where: { orgId_key: { orgId, key } },
      data: {
        ...(rest.persona !== undefined ? { persona: rest.persona } : {}),
        ...(rest.model !== undefined ? { model: rest.model } : {}),
        ...(rest.toolScope !== undefined ? { toolScope: rest.toolScope } : {}),
      },
      select: {
        id: true,
        key: true,
        displayName: true,
        persona: true,
        model: true,
        toolScope: true,
        enabledMcp: true,
        scheduleCron: true,
      },
    });
    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
