import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { clearSsoProvisioned } from "@/lib/auth/sso-provisioned-admin";

/**
 * Clear the IdP-made flag on one account, when an instance admin knows its
 * owner made it. Audited in every org the account is tied to.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const me = await requireSystemAdmin();
    if (!me) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const { userId } = await params;
    if (!(await clearSsoProvisioned(me.id, userId))) {
      return NextResponse.json({ error: "That account isn't marked as made by single sign-on." }, { status: 404 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
