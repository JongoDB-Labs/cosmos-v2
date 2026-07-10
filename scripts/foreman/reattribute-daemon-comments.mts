// One-time (idempotent) reattribution: before the Foreman bot existed, the
// daemon's ticket comments were authored as the maintainer's own account. Move
// ONLY the daemon-signature comments to the bot — a genuine human comment never
// matches these machine-generated prefixes, and the scope is limited to pool
// (autonomous-delivery) projects. Prints per-pattern counts; safe to re-run.
//
//   DATABASE_URL=postgresql://… npx tsx scripts/foreman/reattribute-daemon-comments.mts
import { prisma } from "@/lib/db/client";
import { deliveryProjects, botUserId } from "./db.mjs";

const OLD_ACTOR = "f1244511-9f53-4a78-b4d0-91851b50de2e"; // the pre-bot actor of record

/** Every comment shape the daemon has ever written (run.mts/db.mts history). */
const SIGNATURES = [
  "**Foreman — ",
  "Needs review — ",
  "Shipped v",
  "Shipped approved change",
  "Already implemented",
  "Resolved as duplicate of ",
  "❓ Needs your input",
  "Halted by kill switch",
  "Approved + already live",
  "Approved; image build",
  "Approved but deploy health-gate failed",
  "Deploy health-gate failed",
  "Ship failed before deploy",
  "Repeatedly failed to process",
  "Got it — requeued",
];

const bot = await botUserId();
if (bot === OLD_ACTOR) {
  console.error("bot user not provisioned yet — run create-bot-user.mts first");
  process.exit(1);
}
const pool = await deliveryProjects();
const projectIds = pool.map((p) => p.projectId);
if (projectIds.length === 0) {
  console.log("no pool projects — nothing to do");
  process.exit(0);
}
let total = 0;
for (const sig of SIGNATURES) {
  const r = await prisma.comment.updateMany({
    where: {
      authorId: OLD_ACTOR,
      content: { startsWith: sig },
      workItem: { projectId: { in: projectIds } },
    },
    data: { authorId: bot },
  });
  if (r.count > 0) console.log(`${String(r.count).padStart(4)}  ${sig}`);
  total += r.count;
}
console.log(`reattributed ${total} daemon comments → Foreman (${bot})`);
