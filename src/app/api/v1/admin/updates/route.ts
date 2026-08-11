import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { checkForUpdates, updateConfigFromEnv } from "@/lib/updates/check";
import { listTags, resolveDigest } from "@/lib/updates/registry";
import { CURRENT_VERSION } from "@/lib/changelog";

/**
 * Is a newer application image available?
 *
 * READ-ONLY, AND ONLY GET. There is deliberately no POST here. The app runs
 * inside the image this endpoint describes and cannot replace itself; an
 * endpoint that could would also be a path from the web tier into the host.
 * Applying an upgrade belongs to the host-side runner that already owns
 * `deploy-migrate.sh` and its restore-on-fail.
 *
 * Gate: SYSTEM admin (INTERNAL_ADMINS), matching the other instance-wide admin
 * surfaces. An image upgrade is instance-wide, so "owner of any org" is the
 * wrong tier — self-service org creation mints OWNER, which would make this an
 * escalation path. No RBAC permission bit is used because none fits: that
 * bitfield is entirely per-org, and inventing an org-scoped bit for an
 * instance-wide control would recreate the same escalation.
 *
 * THE REGISTRY COMES FROM THE ENVIRONMENT, NEVER THE REQUEST. This route reads
 * no query parameters and no body on purpose. A caller-supplied registry host
 * would turn an authenticated admin endpoint into an SSRF primitive that also
 * attaches the deployment's registry credentials to the outbound call.
 */
export async function GET() {
  try {
    const user = await requireSystemAdmin();
    if (!user) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = await checkForUpdates(CURRENT_VERSION, updateConfigFromEnv(), {
      listTags,
      resolveDigest,
      probeDb: async () => {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      },
      // The instance's own health, read in-process. Not an HTTP call to
      // ourselves: that would traverse nginx and the tunnel and report on the
      // proxy as much as on the app.
      probeHealth: async () => {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      },
      now: () => new Date(),
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
