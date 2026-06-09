import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { ensureGeneralChannel, autoJoinGeneral } from "@/lib/chat/seed-general";
import { z } from "zod";
import { Plan } from "@prisma/client";
import { provisionComplianceBaseline } from "@/lib/compliance/provision";
import { isReservedSlug } from "@/lib/org/reserved-slugs";
import { isInternalAdmin } from "@/lib/internal/access";

const createOrgSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
  plan: z.nativeEnum(Plan).optional(),
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
        ...(data.plan ? { plan: data.plan } : {}),
        members: {
          create: {
            userId: user.id,
            role: "OWNER",
          },
        },
      },
    });

    await logAudit({
      orgId: org.id,
      userId: user.id,
      action: "org.created",
      entity: "organization",
      entityId: org.id,
      ipAddress: getIpAddress(request),
    });

    // Regulated (GOV) orgs get the NIST 800-171 / CMMC L2 control baseline
    // provisioned out-of-the-box, so a CMMC assessment is ready on day one.
    if (org.plan === "GOV") {
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
