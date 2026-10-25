import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { parseUnsubscribeToken, verifyUnsubscribeMac } from "@/lib/query/subscription-email";

type RouteParams = { params: Promise<{ token: string }> };

/**
 * Unsubscribe from a filter email without signing in (query design §11.2).
 * The token in the link is the credential: it names one person on one
 * subscription, MAC'd with that subscription's own key.
 *
 * GET shows a confirmation with a button; only the POST it sends changes
 * anything, so a mail scanner that follows links can't unsubscribe anyone.
 * For a one-person subscription it is disabled ("unsubscribed"); for a team
 * subscription only this person is muted, and the team keeps getting it.
 */
const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2937}button{padding:.5rem 1rem;border-radius:.375rem;border:1px solid #2563eb;background:#2563eb;color:#fff;font-size:1rem;cursor:pointer}</style>` +
      `</head><body><h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );

async function find(token: string) {
  const t = parseUnsubscribeToken(token);
  if (!t) return null;
  const sub = await prisma.filterSubscription.findUnique({
    where: { id: t.subscriptionId },
    select: { id: true, orgId: true, savedViewId: true, recipientUserId: true, recipientTeamId: true, unsubscribeKey: true, mutedUserIds: true, disabledAt: true },
  });
  if (!sub || !verifyUnsubscribeMac(sub.unsubscribeKey, t)) return null;
  // The token's person must be who the subscription reaches.
  if (sub.recipientUserId ? sub.recipientUserId !== t.userId : !sub.recipientTeamId) return null;
  return { sub, userId: t.userId };
}

const gone = () => page("This link no longer works", "<p>The subscription may already have been removed. You can manage your filter emails from Filters in Cosmos.</p>", 404);

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const found = await find((await params).token);
  if (!found) return gone();
  const already = found.sub.recipientUserId ? !!found.sub.disabledAt : found.sub.mutedUserIds.includes(found.userId);
  if (already) return page("You're unsubscribed", "<p>You won't get this filter email any more.</p>");
  return page(
    "Unsubscribe from this filter email?",
    `<form method="post"><p>You'll stop getting this email. You can subscribe again from the filter in Cosmos.</p><button type="submit">Unsubscribe</button></form>`,
  );
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const found = await find((await params).token);
  if (!found) return gone();
  const { sub, userId } = found;
  if (sub.recipientUserId) {
    await prisma.filterSubscription.update({ where: { id: sub.id }, data: { disabledAt: new Date(), disabledReason: "unsubscribed" } });
  } else if (!sub.mutedUserIds.includes(userId)) {
    await prisma.filterSubscription.update({ where: { id: sub.id }, data: { mutedUserIds: { push: userId } } });
  }
  await logAudit({
    orgId: sub.orgId, userId, action: "saved_filter.unsubscribed_by_link", entity: "saved_view", entityId: sub.savedViewId,
    metadata: { subscriptionId: sub.id, team: !sub.recipientUserId },
  });
  return page("You're unsubscribed", "<p>You won't get this filter email any more.</p>");
}
