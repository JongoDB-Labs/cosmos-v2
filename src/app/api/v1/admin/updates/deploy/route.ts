import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { handleApiError } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { checkForUpdates, updateConfigFromEnv } from "@/lib/updates/check";
import { listTags, resolveDigest } from "@/lib/updates/registry";
import { fetchReleaseNotes } from "@/lib/updates/notes";
import { decideDeploy, refusalStatus, UNIQUE_VIOLATION } from "@/lib/updates/deploy-request";
import { CURRENT_VERSION } from "@/lib/changelog";

/**
 * Record an operator's request to deploy a version — and read the latest one.
 *
 * THIS ENDPOINT DOES NOT DEPLOY. It cannot: the container has no docker socket
 * and no host mount. It writes an INTENT, and a host-side runner claims it and
 * invokes `.deploy/deploy-migrate.sh`. That script remains the entire safety
 * story (pre-deploy pg_dump, migrate while the old app still serves, health
 * gate, restore-on-fail) and nothing here re-expresses any part of it.
 *
 * Until a runner is installed, a request simply sits PENDING. The UI must say
 * exactly that and never imply a deploy happened — a queued row is not a
 * deployment.
 *
 * Gate: SYSTEM admin (INTERNAL_ADMINS), the same tier as the read endpoint.
 * Deploying is instance-wide, so "owner of any org" is the wrong tier:
 * self-service org creation mints OWNER, which would make this an escalation
 * path from any signed-in user to a production deploy.
 *
 * THE ONLY REQUEST INPUT IS A VERSION STRING. No registry, host, tag or command
 * is accepted from the caller — those come from deployment configuration. A
 * caller-supplied registry would make an authenticated admin endpoint an SSRF
 * primitive; a caller-supplied command would make it remote code execution on
 * the host.
 */
const bodySchema = z.object({
  // Constrained to a plain release version. It is passed to the runner and ends
  // up as an argument to a shell script, so it must not be able to carry
  // anything but digits and dots.
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "expected MAJOR.MINOR.PATCH"),
});

function checkDeps() {
  return {
    listTags,
    resolveDigest,
    fetchReleaseNotes,
    probeDb: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
    probeHealth: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
    now: () => new Date(),
  };
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireSystemAdmin();
    if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "A release version is required, as MAJOR.MINOR.PATCH." }, { status: 400 });
    }

    // Re-run the check SERVER-SIDE rather than trusting the page's payload. A
    // screen can be minutes old; images can be deleted and registries can go
    // down while a tab sits open. Deciding from what the browser happened to be
    // holding is how you deploy a version whose images no longer exist.
    const check = await checkForUpdates(CURRENT_VERSION, updateConfigFromEnv(), checkDeps());
    const decision = decideDeploy(parsed.data.version, check);
    if (!decision.ok) {
      return NextResponse.json({ error: decision.detail, reason: decision.reason }, { status: refusalStatus(decision.reason) });
    }

    try {
      const created = await prisma.deployRequest.create({
        data: {
          version: decision.version,
          requestedById: user.id,
          requestedByEmail: user.email,
        },
        select: { id: true, version: true, status: true, requestedAt: true, requestedByEmail: true },
      });
      return NextResponse.json(created, { status: 202 }); // accepted, not performed
    } catch (e) {
      // The database enforces single-flight via a partial unique index over
      // PENDING/RUNNING. Losing that race is not an error condition — it means
      // someone else is already deploying, which is exactly what we want to be
      // impossible to do twice.
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION) {
        const active = await prisma.deployRequest.findFirst({
          where: { status: { in: ["PENDING", "RUNNING"] } },
          select: { id: true, version: true, status: true, requestedAt: true, requestedByEmail: true },
        });
        return NextResponse.json(
          { error: "A deploy is already in progress on this instance.", active, reason: "already-running" },
          { status: 409 },
        );
      }
      throw e;
    }
  } catch (error) {
    return handleApiError(error);
  }
}

/** The most recent request, so the UI can show progress and outcome. */
export async function GET() {
  try {
    const user = await requireSystemAdmin();
    if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const latest = await prisma.deployRequest.findFirst({
      orderBy: { requestedAt: "desc" },
      select: {
        id: true,
        version: true,
        status: true,
        requestedAt: true,
        requestedByEmail: true,
        claimedAt: true,
        claimedBy: true,
        finishedAt: true,
        exitCode: true,
        log: true,
      },
    });
    return NextResponse.json({ latest });
  } catch (error) {
    return handleApiError(error);
  }
}
