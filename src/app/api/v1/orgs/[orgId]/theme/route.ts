import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { revalidateOrg } from "@/lib/cache/queries";

const schema = z.object({
  themePrimary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  themeMode: z.enum(["auto", "dark", "light"]).nullable().optional(),
  logoUrl: z.string()
    .refine((v) => {
      if (v.startsWith("data:image/")) return v.length <= 280_000;
      try {
        const u = new URL(v);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    }, "Must be a data URL ≤200KB or an https URL")
    .nullable()
    .optional(),
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
    if (ctx.orgRole !== "OWNER") {
      return new Response("Forbidden", { status: 403 });
    }

    const body = schema.parse(await request.json());
    const data: { themePrimary?: string | null; themeMode?: string | null; logoUrl?: string | null } = {};
    if (body.themePrimary !== undefined) data.themePrimary = body.themePrimary;
    if (body.themeMode !== undefined) data.themeMode = body.themeMode;
    if (body.logoUrl !== undefined) data.logoUrl = body.logoUrl;
    const updated = await prisma.organization.update({
      where: { id: orgId },
      data,
      select: { id: true, themePrimary: true, themeMode: true, logoUrl: true },
    });

    // The cached `getOrgById`/`getOrgBySlug` rows include `themePrimary`,
    // so the layout would otherwise serve a stale theme until the cache TTL.
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
