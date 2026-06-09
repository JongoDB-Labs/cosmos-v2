import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";

async function requireGlobalAdmin() {
  return requireSystemAdmin();
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireGlobalAdmin();
    if (!user) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { id } = await params;
    await prisma.allowedEmail
      .delete({ where: { id } })
      .catch(() => undefined);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
