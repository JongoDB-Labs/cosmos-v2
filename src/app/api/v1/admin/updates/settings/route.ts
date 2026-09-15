import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, success } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { getUpdateSettings, setUpdateSettings } from "@/lib/updates/settings";

/**
 * The instance's "install updates by yourself?" switch.
 *
 * Same SYSTEM-admin gate as the sibling update routes: an image upgrade is
 * instance-wide, so "owner of any org" is the wrong tier — self-service org
 * creation mints OWNER, which would make this an escalation path.
 *
 * THIS ROUTE STORES A PREFERENCE. It does not deploy, and must not grow into
 * something that does. The sibling GET route is emphatic that the web tier has
 * no path to the host, and a PUT that could trigger an install would reopen
 * exactly that. All this writes is a boolean the host-side daemon reads on its
 * next pass.
 */
export async function GET() {
  try {
    if (!(await requireSystemAdmin())) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return success(await getUpdateSettings());
  } catch (error) {
    return handleApiError(error);
  }
}

const putSchema = z.object({ autoUpdate: z.boolean() });

export async function PUT(request: NextRequest) {
  try {
    const user = await requireSystemAdmin();
    if (!user) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { autoUpdate } = putSchema.parse(await request.json());
    return success(await setUpdateSettings(autoUpdate, user.id ?? null));
  } catch (error) {
    return handleApiError(error);
  }
}
