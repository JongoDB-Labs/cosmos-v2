import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { handleApiError } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";

const createSchema = z.object({
  email: z.string().email(),
});

/**
 * Gate: SYSTEM admin (INTERNAL_ADMINS). The allowlist controls who can sign in
 * to the whole instance, so it's a system-tier control — NOT "owner of any org"
 * (which self-service org creation would let any signed-in user obtain).
 */
async function requireGlobalAdmin() {
  return requireSystemAdmin();
}

// UUID v4 pattern (also matches the gen_random_uuid() output from Postgres)
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  try {
    const user = await requireGlobalAdmin();
    if (!user) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const entries = await prisma.allowedEmail.findMany({
      orderBy: { createdAt: "desc" },
    });

    // Resolve raw UUIDs in addedBy to human-readable names
    const uuids = [
      ...new Set(
        entries
          .map((e) => e.addedBy)
          .filter((v): v is string => !!v && UUID_RE.test(v)),
      ),
    ];

    const userMap = new Map<string, string>();
    if (uuids.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: uuids } },
        select: { id: true, displayName: true, email: true },
      });
      for (const u of users) {
        userMap.set(u.id, u.displayName || u.email);
      }
    }

    const resolved = entries.map((e) => ({
      ...e,
      addedByName:
        e.addedBy && UUID_RE.test(e.addedBy)
          ? userMap.get(e.addedBy) ?? null
          : null,
    }));

    return NextResponse.json(resolved);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireGlobalAdmin();
    if (!user) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { email } = createSchema.parse(body);
    const normalized = email.toLowerCase();

    const existing = await prisma.allowedEmail.findUnique({
      where: { email: normalized },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Email already on the allowlist" },
        { status: 409 },
      );
    }

    const entry = await prisma.allowedEmail.create({
      data: { email: normalized, addedBy: user.email },
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
