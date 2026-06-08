import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { parseOfx } from "@/lib/bank/parsers/ofx";
import { parseCsv } from "@/lib/bank/parsers/csv";
import { importTransactions } from "@/lib/bank/import";

type RouteParams = { params: Promise<{ orgId: string; bankAccountId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, bankAccountId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    // Verify the bank account belongs to this org
    const bankAccount = await prisma.bankAccount.findFirst({
      where: { id: bankAccountId, orgId },
    });
    if (!bankAccount) return new Response("Not found", { status: 404 });

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return new Response("Missing or invalid multipart body", { status: 400 });
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return new Response("file required", { status: 400 });
    }

    const format = String(formData.get("format") || "ofx");
    const mappingRaw = formData.get("mapping");
    const mapping = mappingRaw ? JSON.parse(String(mappingRaw)) : undefined;

    if (format === "csv" && !mapping) {
      return new Response("mapping is required for CSV import", { status: 400 });
    }

    const text = await file.text();
    const parsed = format === "csv" ? parseCsv(text, mapping) : parseOfx(text);

    return success(await importTransactions(orgId, bankAccountId, parsed));
  } catch (error) {
    return handleApiError(error);
  }
}
