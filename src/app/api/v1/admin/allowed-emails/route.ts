import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { handleApiError } from "@/lib/api-helpers";

const createSchema = z.object({
  email: z.string().email(),
});

/**
 * Gate: the caller must be an OWNER of at least one org. The allowlist is a
 * global resource (it controls who can sign in at all), so it intentionally
 * isn't tied to a specific org.
 */
async function requireGlobalAdmin() {
  const user = await getCurrentUser();
  if (!user) return null;
  const ownerMembership = await prisma.orgMember.findFirst({
    where: { userId: user.id, role: "OWNER" },
    select: { id: true },
  });
  if (!ownerMembership) return null;
  return user;
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
