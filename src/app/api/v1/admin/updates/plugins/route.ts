import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, success } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { pluginVersionStatus, reconcilePluginForAllOrgs } from "@/lib/updates/plugins";

/**
 * Plugin versions, and applying an upgrade that has not happened on its own.
 *
 * SEPARATE FROM ../route.ts, which is deliberately GET-only because the app
 * cannot replace the image it runs inside. That reasoning does not extend here:
 * this changes nothing about the image. It runs a plugin's own upgrade hook and
 * stamps a row in this instance's database — work the app already does for
 * itself on the read path, just on demand rather than when somebody happens to
 * open the plugin.
 *
 * Same SYSTEM-admin gate as its sibling. A plugin upgrade touches every org that
 * has the plugin enabled, so an org-scoped permission would be the wrong tier —
 * self-service org creation mints OWNER, which would make an org-scoped bit an
 * escalation path into other orgs' data.
 */
export async function GET() {
  try {
    if (!(await requireSystemAdmin())) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return success({ plugins: await pluginVersionStatus() });
  } catch (error) {
    return handleApiError(error);
  }
}

const bodySchema = z.object({ slug: z.string().min(1).max(64) });

export async function POST(request: NextRequest) {
  try {
    if (!(await requireSystemAdmin())) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { slug } = bodySchema.parse(await request.json());
    const result = await reconcilePluginForAllOrgs(slug);
    // 207 when some orgs did not move: the others DID, and the caller needs to
    // know which failed rather than a blanket failure that hides the successes.
    return success(result, result.failed.length > 0 ? 207 : 200);
  } catch (error) {
    return handleApiError(error);
  }
}
