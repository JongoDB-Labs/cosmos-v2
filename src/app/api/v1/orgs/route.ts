import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { ensureGeneralChannel, autoJoinGeneral } from "@/lib/chat/seed-general";
import { z } from "zod";
import { provisionComplianceBaseline } from "@/lib/compliance/provision";
import { provisionEntitlements } from "@/lib/entitlements";
import { seedBuiltinWorkRoles } from "@/lib/rbac/builtin-work-roles-seed";
import { isReservedSlug } from "@/lib/org/reserved-slugs";
import { isInternalAdmin } from "@/lib/internal/access";

// NOTE: `plan` is intentionally NOT accepted here. New orgs take the schema
// default (ENTERPRISE); changing a plan is a PLATFORM-ADMIN action only, via
// /api/internal/orgs/[orgId]/plan — never org-owner self-service at create time.
const createOrgSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
});

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return new Response("Unauthorized", { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: currentUser.id },
      include: {
        memberships: {
          include: { org: true },
        },
      },
    });

    if (!user) return new Response("User not found", { status: 404 });

    const orgs = user.memberships.map((m) => ({
      id: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      plan: m.org.plan,
      logoUrl: m.org.logoUrl,
      role: m.role,
      joinedAt: m.joinedAt,
    }));

    return success(orgs);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return new Response("Unauthorized", { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: currentUser.id },
    });
    if (!user) return new Response("User not found", { status: 404 });

    // Login-gate: being able to sign in (allowlisted/federated) does NOT by
    // itself grant the ability to bootstrap an org and self-assign OWNER. Only
    // a SYSTEM admin or an EXISTING org member may create an org — everyone else
    // must be invited/provisioned by an admin.
    if (!isInternalAdmin(user.email, process.env.INTERNAL_ADMINS)) {
      const existingMembership = await prisma.orgMember.findFirst({
        where: { userId: user.id },
        select: { id: true },
      });
      if (!existingMembership) {
        return new Response(
          JSON.stringify({
            error:
              "You need an invitation to join. Ask an admin to invite you to an organization.",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const body = await request.json();
    const data = createOrgSchema.parse(body);

    if (isReservedSlug(data.slug)) {
      return new Response(
        JSON.stringify({ error: "That URL is reserved. Pick a different one." }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const existing = await prisma.organization.findUnique({
      where: { slug: data.slug },
    });
    if (existing) {
      return new Response(
        JSON.stringify({ error: "Organization slug already taken" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // NOTE: do not `include: { members: true }` — OrgMember.permissions is
    // BigInt and breaks JSON.stringify in the response helper.
    const org = await prisma.organization.create({
      data: {
        name: data.name,
        slug: data.slug,
        members: {
          create: {
            userId: user.id,
            role: "OWNER",
          },
        },
      },
    });

    // Best-effort: preset roles failing must not fail org creation.
    await seedBuiltinWorkRoles(org.id).catch((e) => console.error("builtin role seed failed:", e));

    await logAudit({
      orgId: org.id,
      userId: user.id,
      action: "org.created",
      entity: "organization",
      entityId: org.id,
      ipAddress: getIpAddress(request),
    });

    // Apply the active product's default entitlements. A row is written only when
    // the product restricts something (e.g. Pontis → AEC sector only); COSMOS orgs
    // stay row-free, which the loader reads as "all enabled" — no behavior change.
    try {
      await provisionEntitlements(org.id);
    } catch (err) {
      console.warn("[entitlements] failed to provision defaults for new org", org.id, err);
    }

    // Regulated (GOV) orgs get the NIST 800-171 / CMMC L2 control baseline
    // provisioned out-of-the-box, so a CMMC assessment is ready on day one.
    // Regulated-ness is the org's data-classification (tenantClass), NOT its
    // billing plan — new orgs default to tenantClass GOV (fail-closed).
    if (org.tenantClass === "GOV") {
      try {
        const { count, framework } = await provisionComplianceBaseline(org.id);
        await logAudit({
          orgId: org.id,
          userId: user.id,
          action: "compliance_baseline.provisioned",
          entity: "compliance_baseline",
          entityId: org.id,
          metadata: { framework: String(framework), count },
          ipAddress: getIpAddress(request),
        });
      } catch (err) {
        console.warn("[compliance] failed to provision baseline for new GOV org", org.id, err);
      }
    }

    try {
      await ensureGeneralChannel(org.id, user.id);
      await autoJoinGeneral(org.id, user.id, true); // creator is always OWNER
    } catch (err) {
      console.warn("[chat] failed to seed #general for new org", org.id, err);
    }

    try {
      publishToOrg(org.id, "org.created", { id: org.id, name: org.name });
    } catch {
      /* never let a broker error break the create response */
    }

    return created(org);
  } catch (error) {
    return handleApiError(error);
  }
}
