import { NextRequest } from "next/server";
import { z } from "zod";
import { AccountType, NormalBalance } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { seedSystemCoA } from "@/lib/ledger/chart-of-accounts";

type RouteParams = { params: Promise<{ orgId: string }> };

// A new account's natural side follows its type unless overridden: assets and
// expenses are debit-normal; liabilities, equity, and revenue are credit-normal.
function defaultNormalBalance(type: AccountType): NormalBalance {
  return type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT";
}

const createSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  type: z.nativeEnum(AccountType),
  normalBalance: z.nativeEnum(NormalBalance).optional(),
  parentId: z.string().uuid().nullish(),
});

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ACCOUNTING_READ);

    if ((await prisma.account.count({ where: { orgId } })) === 0) await seedSystemCoA(orgId);
    const accounts = await prisma.account.findMany({
      where: { orgId },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, type: true, normalBalance: true, isActive: true, parentId: true },
    });
    return success({ data: accounts, total: accounts.length });
  } catch (error) {
    return handleApiError(error);
  }
}

/** POST — add a Chart-of-Accounts account (manage gate). Code is unique per org. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ACCOUNTING_MANAGE);

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });
    const { code, name, type, normalBalance, parentId } = parsed.data;

    // Code must be unique within the org.
    const dup = await prisma.account.findFirst({ where: { orgId, code } });
    if (dup) {
      return new Response(JSON.stringify({ error: "An account with that code already exists" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    // A parent, if given, must belong to the same org.
    if (parentId) {
      const parent = await prisma.account.findFirst({ where: { id: parentId, orgId } });
      if (!parent) return new Response("Bad Request", { status: 400 });
    }

    const account = await prisma.account.create({
      data: {
        orgId,
        code,
        name,
        type,
        normalBalance: normalBalance ?? defaultNormalBalance(type),
        parentId: parentId ?? null,
        isActive: true,
        isSystem: false,
      },
      select: { id: true, code: true, name: true, type: true, normalBalance: true, isActive: true, parentId: true },
    });
    return created(account);
  } catch (error) {
    return handleApiError(error);
  }
}
