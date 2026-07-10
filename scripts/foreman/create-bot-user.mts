// One-time (idempotent) provisioning of the Foreman BOT identity: the user row
// the daemon's comments/moves/notifications are attributed to, and the handle
// maintainers @-mention to instruct it (see src/lib/foreman/mention.ts).
// Membership is granted in every org currently in the autonomous-delivery pool,
// as MEMBER — the bot needs attribution + mentionability, never RBAC power (the
// daemon writes via its own Prisma client, not the app's permission paths).
//
// Run on the host against the target DB:
//   DATABASE_URL=postgresql://… npx tsx scripts/foreman/create-bot-user.mts
import { prisma } from "@/lib/db/client";
import { deliveryProjects } from "./db.mjs";

const EMAIL = "foreman@cosmos.internal";

const existing = await prisma.user.findFirst({ where: { email: EMAIL }, select: { id: true } });
const bot =
  existing ??
  (await prisma.user.create({
    data: {
      email: EMAIL,
      displayName: "Foreman",
      avatarUrl: "/avatars/foreman.svg",
    },
    select: { id: true },
  }));
console.log(`${existing ? "exists" : "created"} bot user ${bot.id}`);

const pool = await deliveryProjects();
const orgIds = [...new Set(pool.map((p) => p.orgId))];
for (const orgId of orgIds) {
  const member = await prisma.orgMember.findFirst({ where: { orgId, userId: bot.id }, select: { id: true } });
  if (member) {
    console.log(`membership exists in org ${orgId}`);
    continue;
  }
  await prisma.orgMember.create({ data: { orgId, userId: bot.id, role: "MEMBER" } });
  console.log(`added MEMBER membership in org ${orgId}`);
}
console.log("done");
