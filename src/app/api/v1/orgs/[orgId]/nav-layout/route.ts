import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { readNavLayout, UNHIDEABLE_NAV_IDS } from "@/lib/nav/nav-layout";
import { z } from "zod";

const schema = z.object({
  /** Top-level section ids to hide from this org's sidebar. */
  hidden: z.array(z.string().min(1).max(64)).max(64),
});

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Which sections this organisation shows in its sidebar.
 *
 * A whole-org decision rather than a personal preference: the practice decides
 * once what its people see, so nobody is quietly looking at a different product
 * from the person beside them.
 *
 * This only ever CONSTRAINS. Permission, entitlement and plugin filtering all
 * run before it in the sidebar, so an id listed here can hide something a user
 * could already see and can never reveal something they could not.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true, settings: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    const data = schema.parse(await request.json());

    // Refused, not silently filtered. An admin who ticks "hide Settings" has
    // misunderstood what the control does, and quietly ignoring it would leave
    // them believing it worked.
    const forbidden = data.hidden.filter((id) =>
      (UNHIDEABLE_NAV_IDS as readonly string[]).includes(id),
    );
    if (forbidden.length > 0) {
      return new Response(
        JSON.stringify({
          error: `These sections cannot be hidden, or nobody could reach them again: ${forbidden.join(", ")}`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const settings =
      typeof org.settings === "object" && org.settings !== null
        ? (org.settings as Record<string, unknown>)
        : {};
    const previous = readNavLayout(settings);

    // Merge, never replace: `settings` is shared with other features and a
    // wholesale write here would drop whatever they keep in it.
    const existingLayout =
      typeof settings.navLayout === "object" && settings.navLayout !== null
        ? (settings.navLayout as Record<string, unknown>)
        : {};

    await prisma.organization.update({
      where: { id: orgId },
      data: { settings: { ...settings, navLayout: { ...existingLayout, hidden: data.hidden } } },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "org.nav_layout_updated",
      entity: "organization",
      entityId: orgId,
      metadata: {
        hidden: data.hidden.join(",") || "(none)",
        previousHidden: previous?.hidden?.join(",") || "(none)",
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ hidden: data.hidden });
  } catch (error) {
    return handleApiError(error);
  }
}
