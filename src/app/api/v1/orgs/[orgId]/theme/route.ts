import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { isValidSkinId } from "@/lib/theme/cookie";
import { revalidateOrg } from "@/lib/cache/queries";
import { logoUrlSchema } from "@/lib/security/image-url";

const schema = z.object({
  themePrimary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  themeMode: z.enum(["auto", "dark", "light"]).nullable().optional(),
  logoUrl: logoUrlSchema,
  // ── Phase 2: per-org white-label brand. All nullable (null = inherit the
  //    deployment/product default). defaultSkinId is checked against the skin
  //    registry; the free-text identity fields are length-bounded so a stray
  //    paste can't bloat the chrome.
  defaultSkinId: z.string()
    .refine((v) => isValidSkinId(v), "Unknown skin preset")
    .nullable()
    .optional(),
  brandName: z.string().trim().min(1).max(60).nullable().optional(),
  agentName: z.string().trim().min(1).max(60).nullable().optional(),
  tagline: z.string().trim().min(1).max(120).nullable().optional(),
  wakeWord: z.string().trim().min(1).max(40).nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.THEME_MANAGE);

    const body = schema.parse(await request.json());
    const data: {
      themePrimary?: string | null;
      themeMode?: string | null;
      logoUrl?: string | null;
      defaultSkinId?: string | null;
      brandName?: string | null;
      agentName?: string | null;
      tagline?: string | null;
      wakeWord?: string | null;
    } = {};
    if (body.themePrimary !== undefined) data.themePrimary = body.themePrimary;
    if (body.themeMode !== undefined) data.themeMode = body.themeMode;
    if (body.logoUrl !== undefined) data.logoUrl = body.logoUrl;
    if (body.defaultSkinId !== undefined) data.defaultSkinId = body.defaultSkinId;
    if (body.brandName !== undefined) data.brandName = body.brandName;
    if (body.agentName !== undefined) data.agentName = body.agentName;
    if (body.tagline !== undefined) data.tagline = body.tagline;
    if (body.wakeWord !== undefined) data.wakeWord = body.wakeWord;

    const updated = await prisma.organization.update({
      where: { id: orgId },
      data,
      select: {
        id: true,
        themePrimary: true,
        themeMode: true,
        logoUrl: true,
        defaultSkinId: true,
        brandName: true,
        agentName: true,
        tagline: true,
        wakeWord: true,
      },
    });

    // Bust the cached org rows (getOrgById/getOrgBySlug cache name + themePrimary)
    // so theme changes show immediately. Brand-field changes propagate separately
    // via the dashboard layout's fresh `include: { org: true }` load.
    revalidateOrg({ id: orgId, slug: org.slug });

    return success(updated);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request", issues: e.issues },
        { status: 400 },
      );
    }
    return handleApiError(e);
  }
}
