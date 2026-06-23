#!/usr/bin/env node
/**
 * Dev-only helper: creates (or reuses) a "dev" user, attaches them to the
 * first organization as OWNER, and mints a Session row valid for 30 days.
 * Prints the session id to stdout — set it on the `session` cookie at
 * localhost:3000 to log in.
 *
 * Idempotent: re-running re-uses the same user + org-membership and just
 * mints a fresh session row.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const DEV_EMAIL = "dev-playwright@cosmos.local";

async function main() {
  // Pick the first org. We need *some* org to slot the user into; we don't
  // want to invent a new one because the rest of the app's seed data lives
  // against existing orgs.
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } });
  if (!org) {
    console.error("No Organization rows found — seed an org first.");
    process.exit(1);
  }

  // Upsert user
  const user = await prisma.user.upsert({
    where: { email: DEV_EMAIL },
    update: {},
    create: {
      email: DEV_EMAIL,
      displayName: "Dev Playwright",
    },
  }).catch(async (e) => {
    if (String(e?.message).includes("Unique") || String(e?.message).includes("findUnique")) {
      // email isn't @unique in this schema — fall back to find-or-create
      const existing = await prisma.user.findFirst({ where: { email: DEV_EMAIL } });
      if (existing) return existing;
      return prisma.user.create({
        data: { email: DEV_EMAIL, displayName: "Dev Playwright" },
      });
    }
    throw e;
  });

  // Upsert membership in the chosen org as OWNER
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId: org.id, userId: user.id } },
    update: { role: "OWNER" },
    create: { orgId: org.id, userId: user.id, role: "OWNER" },
  });

  // Mint a session
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: { id: sessionId, userId: user.id, expiresAt },
  });

  console.log(JSON.stringify({
    sessionId,
    userId: user.id,
    email: user.email,
    orgSlug: org.slug,
    orgId: org.id,
    expiresAt: expiresAt.toISOString(),
  }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
