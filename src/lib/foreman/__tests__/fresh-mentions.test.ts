// DB-backed (real e2e DB, no mocks besides the fixtures themselves) coverage for
// the bare-comment ingestion source added to freshMentions() in scripts/foreman/db.mts:
// a privileged member's plain reply on a PARKED review-column ticket is an
// instruction even with no @Foreman token — the ticket is already sitting in
// front of them for approval.
//
// Fixtures live under a dedicated THROWAWAY org+project (requeue.test.ts's
// "foreign org" pattern), not the shared test-org/TEST project status-read.test.ts
// also seeds work items into — vitest runs test FILES in parallel against the
// same e2e DB, and two files both computing "max(ticketNumber)+1" for the same
// project races (observed: a real `(org_id, project_id, ticket_number)` unique
// -constraint failure when this test shared test-org's project). A dedicated org
// also means the autonomousDelivery settings toggle freshMentions() needs never
// touches shared state, so there's nothing to save/restore.
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/client";
import { freshMentions, botUserId } from "../../../../scripts/foreman/db.mjs";

describe("freshMentions — bare-comment ingestion on parked tickets", () => {
  it("returns a privileged bare comment on a parked review ticket, gated by column/author-privilege/bot-authorship/parked-event, and normalizes a null data.sessionId to undefined", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } });
    const bob = await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" }, select: { id: true } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null }, select: { id: true } });
    const bot = await botUserId();

    const org = await prisma.organization.create({
      data: { name: `fresh-mentions-test-${stamp}`, slug: `fresh-mentions-test-${stamp}` },
    });
    const orgId = org.id;
    const orgIds = [orgId]; // cleanup tracker (deleteMany at the end; cascades org_members + project)

    const project = await prisma.project.create({
      data: { orgId, name: "Fresh Mentions Test", key: `FM${stamp.slice(-6).toUpperCase()}` },
    });
    const projectId = project.id;

    // freshMentions() -> deliveryProjects() only pools orgs with autonomousDelivery
    // enabled and this project's id listed. A fresh org, so no save/restore needed.
    await prisma.organization.update({
      where: { id: orgId },
      data: {
        settings: { autonomousDelivery: { enabled: true, projectIds: [projectId], workers: 1, notify: { parked: true, shipped: true } } },
      },
    });

    // privilegedUserIds(orgId) is scoped to THIS org's members, so alice/bob need
    // membership here too, not just in the shared test-org.
    await prisma.orgMember.create({ data: { orgId, userId: alice.id, role: "ADMIN" } });
    await prisma.orgMember.create({ data: { orgId, userId: bob.id, role: "MEMBER" } });

    async function createItem(columnKey: string, ticketNumber: number, suffix: string) {
      return prisma.workItem.create({
        data: {
          orgId,
          projectId,
          ticketNumber,
          title: `[fresh-mentions-test] ${columnKey} ${stamp}-${suffix}`,
          description: "",
          columnKey,
          workItemTypeId: type.id,
          createdById: alice.id,
          // Review items enter review BEFORE the follow-up comment under test — set in
          // the past so the comment is unambiguously past freshMentions' review-column
          // watermark (createdAt > columnEnteredAt), exercising the real comparison
          // rather than relying on a null columnEnteredAt skipping it.
          columnEnteredAt: columnKey === "review" ? new Date(Date.now() - 60_000) : undefined,
        },
      });
    }

    const itemIds: string[] = [];
    const eventIds: string[] = [];

    try {
      // Case 1: a privileged (ADMIN) bare comment on a parked review ticket → returned,
      // with `parked` populated from the latest parked event's data.
      const parkedItem = await createItem("review", 1, "parked");
      itemIds.push(parkedItem.id);
      const parkedEvent = await prisma.foremanEvent.create({
        data: {
          workItemId: parkedItem.id, orgId, ticketKey: "TST-901", kind: "parked", ts: new Date(),
          message: "checks failed", data: { sessionId: "sess-1", branch: "auto/TST-9" },
        },
      });
      eventIds.push(parkedEvent.id);
      const markerText = `fresh-mentions-test bare instruction ${stamp}`;
      await prisma.comment.create({ data: { orgId, workItemId: parkedItem.id, authorId: alice.id, content: markerText } });

      // Case 2: the SAME comment text, on a backlog-column item with no parked event at
      // all → NOT returned. Proves the columnKey==="review" gate, not just a content match.
      const backlogItem = await createItem("backlog", 2, "backlog");
      itemIds.push(backlogItem.id);
      await prisma.comment.create({ data: { orgId, workItemId: backlogItem.id, authorId: alice.id, content: markerText } });

      // Case 3: a non-privileged (MEMBER) bare comment on ITS OWN parked review ticket →
      // NOT returned. A dedicated item (not case 1's) so the shared per-item "one
      // mention wins" dedupe in freshMentions can't mask a broken privilege check by
      // having case 1's comment already claim the item.
      const nonPrivItem = await createItem("review", 3, "nonpriv");
      itemIds.push(nonPrivItem.id);
      const nonPrivEvent = await prisma.foremanEvent.create({
        data: { workItemId: nonPrivItem.id, orgId, kind: "gated", ts: new Date(), message: "repeatedly failed", data: { branch: "auto/TST-10" } },
      });
      eventIds.push(nonPrivEvent.id);
      await prisma.comment.create({
        data: { orgId, workItemId: nonPrivItem.id, authorId: bob.id, content: `fresh-mentions-test nonpriv ${stamp}` },
      });

      // Case 4: the bot's own comment on its own parked review ticket → NOT returned.
      const botItem = await createItem("review", 4, "bot");
      itemIds.push(botItem.id);
      const botEvent = await prisma.foremanEvent.create({
        data: { workItemId: botItem.id, orgId, kind: "parked", ts: new Date(), message: "needs input", data: { branch: "auto/TST-11" } },
      });
      eventIds.push(botEvent.id);
      await prisma.comment.create({
        data: { orgId, workItemId: botItem.id, authorId: bot, content: `fresh-mentions-test bot-authored ${stamp}` },
      });

      // Case 5: a parked event whose data.sessionId is explicitly `null` (a JSON
      // round-trip of an absent value, not merely an omitted key) → returned, with
      // parked.sessionId normalized to `undefined` rather than passed through as `null`.
      const nullSessionItem = await createItem("review", 5, "nullsession");
      itemIds.push(nullSessionItem.id);
      const nullSessionEvent = await prisma.foremanEvent.create({
        data: {
          workItemId: nullSessionItem.id, orgId, kind: "parked", ts: new Date(),
          message: "checks failed", data: { sessionId: null, branch: "auto/TST-12" },
        },
      });
      eventIds.push(nullSessionEvent.id);
      await prisma.comment.create({
        data: { orgId, workItemId: nullSessionItem.id, authorId: alice.id, content: `fresh-mentions-test nullsession ${stamp}` },
      });

      const fresh = await freshMentions();

      const parkedRow = fresh.find((m) => m.itemId === parkedItem.id);
      expect(parkedRow).toBeDefined();
      expect(parkedRow?.columnKey).toBe("review");
      expect(parkedRow?.askerUserId).toBe(alice.id);
      expect(parkedRow?.question).toBe(markerText);
      expect(parkedRow?.parked?.sessionId).toBe("sess-1");
      expect(parkedRow?.parked?.branch).toBe("auto/TST-9");
      expect(parkedRow?.parked?.prUrl).toBeUndefined();

      expect(fresh.find((m) => m.itemId === backlogItem.id)).toBeUndefined();
      expect(fresh.find((m) => m.itemId === nonPrivItem.id)).toBeUndefined();
      expect(fresh.find((m) => m.itemId === botItem.id)).toBeUndefined();

      const nullSessionRow = fresh.find((m) => m.itemId === nullSessionItem.id);
      expect(nullSessionRow).toBeDefined();
      expect(nullSessionRow?.parked?.sessionId).toBeUndefined();
      expect(nullSessionRow?.parked?.branch).toBe("auto/TST-12");
    } finally {
      await prisma.comment.deleteMany({ where: { workItemId: { in: itemIds } } });
      await prisma.foremanEvent.deleteMany({ where: { id: { in: eventIds } } });
      // work_items has no FK to organizations/projects (plain denormalized columns),
      // so the org delete below won't cascade to these — clean up explicitly first.
      await prisma.workItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });
});
