import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { listSsoProvisioned } from "@/lib/auth/sso-provisioned-admin";

/**
 * Accounts marked as made by an organization's IdP. Instance admins only
 * (INTERNAL_ADMINS, through requireSystemAdmin).
 */
export async function GET() {
  try {
    const me = await requireSystemAdmin();
    if (!me) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json(await listSsoProvisioned());
  } catch (error) {
    return handleApiError(error);
  }
}
