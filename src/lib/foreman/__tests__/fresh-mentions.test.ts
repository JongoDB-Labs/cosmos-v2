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

  it("watermark-reject: excludes bare comments created before columnEnteredAt", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null }, select: { id: true } });

    const org = await prisma.organization.create({
      data: { name: `watermark-test-${stamp}`, slug: `watermark-test-${stamp}` },
    });
    const orgId = org.id;
    const orgIds = [orgId];

    const project = await prisma.project.create({
      data: { orgId, name: "Watermark Test", key: `WM${stamp.slice(-6).toUpperCase()}` },
    });
    const projectId = project.id;

    await prisma.organization.update({
      where: { id: orgId },
      data: {
        settings: { autonomousDelivery: { enabled: true, projectIds: [projectId], workers: 1, notify: { parked: true, shipped: true } } },
      },
    });

    await prisma.orgMember.create({ data: { orgId, userId: alice.id, role: "ADMIN" } });

    const itemIds: string[] = [];
    const eventIds: string[] = [];

    try {
      // Item with columnEnteredAt = NOW (freshly requeued)
      const columnEnteredAtTime = new Date();
      const watermarkItem = await prisma.workItem.create({
        data: {
          orgId,
          projectId,
          ticketNumber: 1,
          title: `[watermark-test] watermark ${stamp}`,
          description: "",
          columnKey: "review",
          workItemTypeId: type.id,
          createdById: alice.id,
          columnEnteredAt: columnEnteredAtTime,
        },
      });
      itemIds.push(watermarkItem.id);

      // Parked event so the bare comment ingestion path activates
      const parkEvent = await prisma.foremanEvent.create({
        data: {
          workItemId: watermarkItem.id, orgId, ticketKey: "WM-001", kind: "parked", ts: new Date(),
          message: "needs review", data: { sessionId: "sess-wm", branch: "auto/WM-1" },
        },
      });
      eventIds.push(parkEvent.id);

      // Comment created BEFORE columnEnteredAt (60 seconds in the past)
      const commentCreatedAt = new Date(columnEnteredAtTime.getTime() - 60_000);
      await prisma.comment.create({
        data: { orgId, workItemId: watermarkItem.id, authorId: alice.id, content: "old comment before watermark" },
        select: { id: true }, // force explicit creation time handling
      });

      // Manually update the comment to set createdAt in the past (Prisma doesn't
      // allow setting createdAt in create/update; we use raw SQL or fetch then update)
      await prisma.$executeRawUnsafe(
        `UPDATE "comments" SET "created_at" = $1 WHERE "work_item_id" = $2`,
        commentCreatedAt,
        watermarkItem.id
      );

      const fresh = await freshMentions();
      const watermarkRow = fresh.find((m) => m.itemId === watermarkItem.id);

      // Should NOT appear because comment.createdAt <= columnEnteredAt
      expect(watermarkRow).toBeUndefined();
    } finally {
      await prisma.comment.deleteMany({ where: { workItemId: { in: itemIds } } });
      await prisma.foremanEvent.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.workItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });

  it("token-and-bare-both-return: a parked item's token comment and a later bare comment BOTH surface, oldest first", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null }, select: { id: true } });
    const bot = await botUserId();
    const token = `<@${bot}>`;

    const org = await prisma.organization.create({
      data: { name: `dedupe-test-${stamp}`, slug: `dedupe-test-${stamp}` },
    });
    const orgId = org.id;
    const orgIds = [orgId];

    const project = await prisma.project.create({
      data: { orgId, name: "Dedupe Test", key: `DE${stamp.slice(-6).toUpperCase()}` },
    });
    const projectId = project.id;

    await prisma.organization.update({
      where: { id: orgId },
      data: {
        settings: { autonomousDelivery: { enabled: true, projectIds: [projectId], workers: 1, notify: { parked: true, shipped: true } } },
      },
    });

    await prisma.orgMember.create({ data: { orgId, userId: alice.id, role: "ADMIN" } });

    const itemIds: string[] = [];
    const eventIds: string[] = [];

    try {
      // Parked review item with columnEnteredAt in the past
      const dedupeItem = await prisma.workItem.create({
        data: {
          orgId,
          projectId,
          ticketNumber: 2,
          title: `[dedupe-test] token+bare ${stamp}`,
          description: "",
          columnKey: "review",
          workItemTypeId: type.id,
          createdById: alice.id,
          columnEnteredAt: new Date(Date.now() - 120_000), // 2 min ago
        },
      });
      itemIds.push(dedupeItem.id);

      // Parked event
      const parkEvent = await prisma.foremanEvent.create({
        data: {
          workItemId: dedupeItem.id, orgId, ticketKey: "DE-002", kind: "parked", ts: new Date(),
          message: "review needed", data: { sessionId: "sess-dedupe", branch: "auto/DE-2" },
        },
      });
      eventIds.push(parkEvent.id);

      // Token comment (explicit instruction)
      const tokenCommentText = `please fix this ${token} carefully`;
      await prisma.comment.create({
        data: { orgId, workItemId: dedupeItem.id, authorId: alice.id, content: tokenCommentText },
      });

      // Bare comment (fallback instruction)
      const bareCommentText = `also remember to test this`;
      await prisma.comment.create({
        data: { orgId, workItemId: dedupeItem.id, authorId: alice.id, content: bareCommentText },
      });

      const fresh = await freshMentions();
      const dedupeRow = fresh.filter((m) => m.itemId === dedupeItem.id);

      // BOTH the token comment and the bare comment now surface for a parked
      // item — a review-column item is no longer capped at one FreshMention per
      // pass, so an older instruct can never again silently swallow a newer
      // approve (or vice versa) before combineIntents sees it. Returned
      // oldest-first: the token comment was created first, so it's index 0; the
      // bare comment (created second) follows at index 1.
      expect(dedupeRow).toHaveLength(2);
      expect(dedupeRow[0]?.question).toContain("please fix this");
      expect(dedupeRow[0]?.question).not.toContain(token);
      expect(dedupeRow[0]?.parked?.sessionId).toBe("sess-dedupe");
      expect(dedupeRow[1]?.question).toBe(bareCommentText);
      expect(dedupeRow[1]?.parked?.sessionId).toBe("sess-dedupe");
    } finally {
      await prisma.comment.deleteMany({ where: { workItemId: { in: itemIds } } });
      await prisma.foremanEvent.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.workItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });

  it("parked-population-on-token-path: token mention on review returns parked.sessionId; on non-review returns null", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null }, select: { id: true } });
    const bot = await botUserId();
    const token = `<@${bot}>`;

    const org = await prisma.organization.create({
      data: { name: `parked-pop-test-${stamp}`, slug: `parked-pop-test-${stamp}` },
    });
    const orgId = org.id;
    const orgIds = [orgId];

    const project = await prisma.project.create({
      data: { orgId, name: "Parked Pop Test", key: `PP${stamp.slice(-6).toUpperCase()}` },
    });
    const projectId = project.id;

    await prisma.organization.update({
      where: { id: orgId },
      data: {
        settings: { autonomousDelivery: { enabled: true, projectIds: [projectId], workers: 1, notify: { parked: true, shipped: true } } },
      },
    });

    await prisma.orgMember.create({ data: { orgId, userId: alice.id, role: "ADMIN" } });

    const itemIds: string[] = [];
    const eventIds: string[] = [];

    try {
      // Case 1: Token mention on a PARKED review item → parked.sessionId is populated
      const reviewParkedItem = await prisma.workItem.create({
        data: {
          orgId,
          projectId,
          ticketNumber: 3,
          title: `[parked-pop-test] review parked ${stamp}`,
          description: "",
          columnKey: "review",
          workItemTypeId: type.id,
          createdById: alice.id,
          columnEnteredAt: new Date(Date.now() - 120_000),
        },
      });
      itemIds.push(reviewParkedItem.id);

      const reviewParkEvent = await prisma.foremanEvent.create({
        data: {
          workItemId: reviewParkedItem.id, orgId, ticketKey: "PP-003", kind: "parked", ts: new Date(),
          message: "checks failed", data: { sessionId: "sess-review-park", branch: "auto/PP-3" },
        },
      });
      eventIds.push(reviewParkEvent.id);

      await prisma.comment.create({
        data: { orgId, workItemId: reviewParkedItem.id, authorId: alice.id, content: `fix this ${token} now` },
      });

      // Case 2: Token mention on a NON-review item (e.g., backlog) → parked should be null
      const backlogItem = await prisma.workItem.create({
        data: {
          orgId,
          projectId,
          ticketNumber: 4,
          title: `[parked-pop-test] backlog token ${stamp}`,
          description: "",
          columnKey: "backlog",
          workItemTypeId: type.id,
          createdById: alice.id,
        },
      });
      itemIds.push(backlogItem.id);

      await prisma.comment.create({
        data: { orgId, workItemId: backlogItem.id, authorId: alice.id, content: `implement this ${token} soon` },
      });

      const fresh = await freshMentions();

      const reviewRow = fresh.find((m) => m.itemId === reviewParkedItem.id);
      expect(reviewRow).toBeDefined();
      expect(reviewRow?.columnKey).toBe("review");
      expect(reviewRow?.parked).toBeDefined();
      expect(reviewRow?.parked?.sessionId).toBe("sess-review-park");
      expect(reviewRow?.parked?.branch).toBe("auto/PP-3");

      const backlogRow = fresh.find((m) => m.itemId === backlogItem.id);
      expect(backlogRow).toBeDefined();
      expect(backlogRow?.columnKey).toBe("backlog");
      // Non-review items should have parked === null
      expect(backlogRow?.parked).toBeNull();
    } finally {
      await prisma.comment.deleteMany({ where: { workItemId: { in: itemIds } } });
      await prisma.foremanEvent.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.workItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });

  it("non-review-still-single: a NON-review item with two fresh token comments still returns exactly one FreshMention", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null }, select: { id: true } });
    const bot = await botUserId();
    const token = `<@${bot}>`;

    const org = await prisma.organization.create({
      data: { name: `nonreview-cap-test-${stamp}`, slug: `nonreview-cap-test-${stamp}` },
    });
    const orgId = org.id;
    const orgIds = [orgId];

    const project = await prisma.project.create({
      data: { orgId, name: "Non-Review Cap Test", key: `NR${stamp.slice(-6).toUpperCase()}` },
    });
    const projectId = project.id;

    await prisma.organization.update({
      where: { id: orgId },
      data: {
        settings: { autonomousDelivery: { enabled: true, projectIds: [projectId], workers: 1, notify: { parked: true, shipped: true } } },
      },
    });

    await prisma.orgMember.create({ data: { orgId, userId: alice.id, role: "ADMIN" } });

    const itemIds: string[] = [];

    try {
      // A non-review (backlog) item — the Q&A watermark path (newer than the
      // bot's last comment), not the review requeue watermark.
      const backlogItem = await prisma.workItem.create({
        data: {
          orgId,
          projectId,
          ticketNumber: 1,
          title: `[nonreview-cap-test] backlog ${stamp}`,
          description: "",
          columnKey: "backlog",
          workItemTypeId: type.id,
          createdById: alice.id,
        },
      });
      itemIds.push(backlogItem.id);

      // TWO fresh token mentions on the SAME non-review item, both privileged
      // and both past the (nonexistent) bot-reply watermark.
      await prisma.comment.create({
        data: { orgId, workItemId: backlogItem.id, authorId: alice.id, content: `first question ${token} please` },
      });
      await prisma.comment.create({
        data: { orgId, workItemId: backlogItem.id, authorId: alice.id, content: `second question ${token} too` },
      });

      const fresh = await freshMentions();
      const rows = fresh.filter((m) => m.itemId === backlogItem.id);

      // Still capped at exactly one — the Q&A reply path (non-review columns)
      // answers a single question per pass; the bot's reply becomes the new
      // watermark that surfaces the second question on the NEXT pass. Only
      // review-column items are exempt from this cap.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.question).toContain("first question");
      expect(rows[0]?.columnKey).toBe("backlog");
    } finally {
      await prisma.comment.deleteMany({ where: { workItemId: { in: itemIds } } });
      await prisma.workItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });

  it("bot-reply watermark (F1): an owner comment older than the bot's last comment is NOT returned; a newer one IS", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null }, select: { id: true } });
    const bot = await botUserId();

    const org = await prisma.organization.create({ data: { name: `botwm-test-${stamp}`, slug: `botwm-test-${stamp}` } });
    const orgId = org.id;
    const orgIds = [orgId];
    const project = await prisma.project.create({ data: { orgId, name: "Bot Watermark Test", key: `BW${stamp.slice(-6).toUpperCase()}` } });
    const projectId = project.id;
    await prisma.organization.update({
      where: { id: orgId },
      data: { settings: { autonomousDelivery: { enabled: true, projectIds: [projectId], workers: 1, notify: { parked: true, shipped: true } } } },
    });
    await prisma.orgMember.create({ data: { orgId, userId: alice.id, role: "ADMIN" } });

    const itemIds: string[] = [];
    const eventIds: string[] = [];

    try {
      // Parked review item; entered review 5 min ago (before every comment below),
      // so columnEnteredAt alone would NOT filter the stale comment — the bot-reply
      // half of the watermark is what must reject it (a terminal approve outcome
      // posts a bot comment but never moves the card off `review`).
      const item = await prisma.workItem.create({
        data: {
          orgId, projectId, ticketNumber: 1,
          title: `[botwm-test] parked ${stamp}`, description: "",
          columnKey: "review", workItemTypeId: type.id, createdById: alice.id,
          columnEnteredAt: new Date(Date.now() - 5 * 60_000),
        },
      });
      itemIds.push(item.id);
      const parkEvent = await prisma.foremanEvent.create({
        data: { workItemId: item.id, orgId, ticketKey: "BW-001", kind: "parked", ts: new Date(), message: "checks failed", data: { sessionId: "sess-bw", branch: "auto/BW-1" } },
      });
      eventIds.push(parkEvent.id);

      // (a) STALE owner comment at T-4min; (bot) reply at T-2min; (b) NEWER owner
      // comment at T-30s. Created here in any order, then backdated by id below
      // (Prisma can't set createdAt on create).
      const staleText = `botwm stale approve ${stamp}`;
      const stale = await prisma.comment.create({ data: { orgId, workItemId: item.id, authorId: alice.id, content: staleText } });
      const botReply = await prisma.comment.create({ data: { orgId, workItemId: item.id, authorId: bot, content: `There's nothing built to merge yet ${stamp}` } });
      const freshText = `botwm rebuild please ${stamp}`;
      const freshOwner = await prisma.comment.create({ data: { orgId, workItemId: item.id, authorId: alice.id, content: freshText } });

      await prisma.$executeRawUnsafe(`UPDATE "comments" SET "created_at" = $1 WHERE "id" = $2`, new Date(Date.now() - 4 * 60_000), stale.id);
      await prisma.$executeRawUnsafe(`UPDATE "comments" SET "created_at" = $1 WHERE "id" = $2`, new Date(Date.now() - 2 * 60_000), botReply.id);
      await prisma.$executeRawUnsafe(`UPDATE "comments" SET "created_at" = $1 WHERE "id" = $2`, new Date(Date.now() - 30_000), freshOwner.id);

      const fresh = await freshMentions();
      const rows = fresh.filter((m) => m.itemId === item.id);

      // Only the post-bot-reply owner comment surfaces; the pre-reply stale one is
      // consumed by the bot-comment watermark, so it can't re-fire forever (F1).
      expect(rows).toHaveLength(1);
      expect(rows[0]?.question).toBe(freshText);
      expect(rows.find((r) => r.question === staleText)).toBeUndefined();
    } finally {
      await prisma.comment.deleteMany({ where: { workItemId: { in: itemIds } } });
      await prisma.foremanEvent.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.workItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });

  it("ship-failed park surfaces on the bare-comment path (shared PARKED_EVENT_KINDS, F3)", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null }, select: { id: true } });

    const org = await prisma.organization.create({ data: { name: `shipfail-test-${stamp}`, slug: `shipfail-test-${stamp}` } });
    const orgId = org.id;
    const orgIds = [orgId];
    const project = await prisma.project.create({ data: { orgId, name: "Ship Failed Test", key: `SF${stamp.slice(-6).toUpperCase()}` } });
    const projectId = project.id;
    await prisma.organization.update({
      where: { id: orgId },
      data: { settings: { autonomousDelivery: { enabled: true, projectIds: [projectId], workers: 1, notify: { parked: true, shipped: true } } } },
    });
    await prisma.orgMember.create({ data: { orgId, userId: alice.id, role: "ADMIN" } });

    const itemIds: string[] = [];
    const eventIds: string[] = [];

    try {
      const item = await prisma.workItem.create({
        data: {
          orgId, projectId, ticketNumber: 1,
          title: `[shipfail-test] parked ${stamp}`, description: "",
          columnKey: "review", workItemTypeId: type.id, createdById: alice.id,
          columnEnteredAt: new Date(Date.now() - 60_000),
        },
      });
      itemIds.push(item.id);

      // A `ship-failed` event — NOT parked/gated. Before F3, freshMentions only
      // recognized parked/gated as "parked", so this item (a PR that failed to
      // merge) was invisible to the approve/resume channel even though the console
      // showed an Approve button. Now ship-failed is in the shared PARKED_EVENT_KINDS.
      const ev = await prisma.foremanEvent.create({
        data: {
          workItemId: item.id, orgId, ticketKey: "SF-001", kind: "ship-failed", ts: new Date(),
          message: "ship failed before merge", data: { prUrl: "https://example.com/pr/sf", branch: "auto/SF-1", sessionId: "sess-sf" },
        },
      });
      eventIds.push(ev.id);
      await prisma.comment.create({ data: { orgId, workItemId: item.id, authorId: alice.id, content: `approve ${stamp}` } });

      const fresh = await freshMentions();
      const row = fresh.find((m) => m.itemId === item.id);
      expect(row).toBeDefined();
      expect(row?.columnKey).toBe("review");
      expect(row?.parked?.prUrl).toBe("https://example.com/pr/sf");
      expect(row?.parked?.branch).toBe("auto/SF-1");
      expect(row?.parked?.sessionId).toBe("sess-sf");
    } finally {
      await prisma.comment.deleteMany({ where: { workItemId: { in: itemIds } } });
      await prisma.foremanEvent.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.workItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });
});
