/**
 * Idempotent seed for E2E test fixtures. Creates:
 *   - org "Test Org" with slug "test-org"
 *   - users alice@test.local (ADMIN), bob@test.local (MEMBER)
 *   - both joined to the org + auto-joined to the #general channel
 *
 * Safe to run multiple times. Used by the H2 Playwright spec.
 *
 * Run with:
 *   npx tsx prisma/seed/test-fixtures.ts
 */
import { Prisma } from "@prisma/client";
import { makePrismaClient } from "./shared/prisma-client";

const prisma = makePrismaClient();

/** Ensure an org has a #general channel. Returns its id. Idempotent. */
async function ensureGeneralChannel(
  orgId: string,
  creatorUserId: string,
): Promise<string> {
  const existing = await prisma.chatChannel.findFirst({
    where: { orgId, isGeneral: true },
    select: { id: true },
  });
  if (existing) return existing.id;
  try {
    const channel = await prisma.chatChannel.create({
      data: {
        orgId,
        kind: "CHANNEL",
        name: "general",
        slug: "general",
        isGeneral: true,
        isPrivate: false,
        createdById: creatorUserId,
      },
      select: { id: true },
    });
    return channel.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const row = await prisma.chatChannel.findFirst({
        where: { orgId, isGeneral: true },
        select: { id: true },
      });
      if (row) return row.id;
    }
    throw e;
  }
}

/** Auto-join a user to their org's #general channel. Idempotent. */
async function autoJoinGeneral(
  orgId: string,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  const general = await prisma.chatChannel.findFirst({
    where: { orgId, isGeneral: true },
    select: { id: true },
  });
  if (!general) return;
  await prisma.chatChannelMember.upsert({
    where: { channelId_userId: { channelId: general.id, userId } },
    update: {},
    create: {
      channelId: general.id,
      userId,
      role: isAdmin ? "ADMIN" : "MEMBER",
    },
  });
}

/**
 * Seed a project + default KANBAN board + 5 columns + alice as MANAGER, so the
 * board / work-item E2E journeys have a stable target. Idempotent (project key
 * is unique per org). Mirrors the no-template branch of the projects POST route.
 * Returns the project id.
 */
async function ensureProjectFixture(
  orgId: string,
  aliceMemberId: string,
): Promise<string> {
  const PROJECT_KEY = "TEST"; // uppercase, matches /^[A-Z][A-Z0-9]*$/
  const existing = await prisma.project.findFirst({
    where: { orgId, key: PROJECT_KEY },
    select: { id: true },
  });
  if (existing) return existing.id;

  const DEFAULT_COLUMNS = [
    { name: "Backlog", key: "backlog", color: "#94a3b8", sortOrder: 0, category: "TODO" as const },
    { name: "To Do", key: "todo", color: "#60a5fa", sortOrder: 1, category: "TODO" as const },
    { name: "In Progress", key: "in-progress", color: "#fbbf24", sortOrder: 2, category: "IN_PROGRESS" as const },
    { name: "Review", key: "review", color: "#a78bfa", sortOrder: 3, category: "IN_PROGRESS" as const },
    { name: "Done", key: "done", color: "#34d399", sortOrder: 4, category: "DONE" as const },
  ];

  return prisma.$transaction(async (tx) => {
    const proj = await tx.project.create({
      data: {
        orgId,
        name: "Test Project",
        key: PROJECT_KEY,
        description: "Seeded for E2E board/work-item journeys",
      },
    });
    const board = await tx.board.create({
      data: { orgId, projectId: proj.id, name: "Board", type: "KANBAN", sortOrder: 0 },
    });
    await tx.boardColumn.createMany({
      data: DEFAULT_COLUMNS.map((c) => ({ boardId: board.id, ...c })),
    });
    // ProjectMember.orgMemberId references OrgMember.id (NOT User.id).
    await tx.projectMember.create({
      data: { projectId: proj.id, orgMemberId: aliceMemberId, role: "MANAGER" },
    });
    return proj.id;
  });
}

/**
 * Seed a SECOND board on the TEST project so the board-switching E2E journey has
 * two tabs to toggle between. Distinct name ("Roadmap") + type (TABLE) so the
 * two tabs are unambiguous, and sortOrder 1 so it stays AFTER the default KANBAN
 * board (sortOrder 0) — the default must remain the /projects/{key} redirect
 * target. Idempotent on (projectId, name). Separate from ensureProjectFixture
 * (which early-returns when the project exists, so re-runs would skip a folded-in
 * board).
 */
async function ensureSecondBoard(orgId: string, projectId: string): Promise<void> {
  const NAME = "Roadmap";
  const existing = await prisma.board.findFirst({
    where: { projectId, name: NAME },
    select: { id: true },
  });
  if (existing) return;
  // KANBAN (no columns) renders a clean "no columns configured" state, so
  // navigating to it during board-switching never errors/redirects.
  await prisma.board.create({
    data: { orgId, projectId, name: NAME, type: "KANBAN", sortOrder: 1 },
  });
}

/**
 * The built-in "Task" work-item type (orgId null, isBuiltIn). The work-items
 * POST route resolves type "TASK" → WorkItemType key "software.task". The main
 * sector seed creates this, but CI runs ONLY this fixture seed, so the
 * work-item journey would 400 without it. Idempotent (NULL orgId trips the
 * composite-unique upsert, so use findFirst + create).
 */
async function ensureBuiltInTaskType(): Promise<void> {
  const existing = await prisma.workItemType.findFirst({
    where: { isBuiltIn: true, key: "software.task" },
    select: { id: true },
  });
  if (existing) return;
  await prisma.workItemType.create({
    data: {
      orgId: null,
      key: "software.task",
      name: "Task",
      pluralName: "Tasks",
      isBuiltIn: true,
      sortOrder: 2,
    },
  });
}

/**
 * Fixtures for the @-tag-any-entity E2E (`e2e/mentions.spec.ts`): a distinct
 * "Falcon" project + work items + a note, plus one backlink reference so the
 * "Mentioned in" panel has content. Idempotent on the FAL project key. Separate
 * from the TEST project so it never affects the board/work-item journeys.
 */
async function ensureMentionFixtures(orgId: string, aliceId: string): Promise<void> {
  const existing = await prisma.project.findFirst({
    where: { orgId, key: "FAL" },
    select: { id: true },
  });
  if (existing) return;
  const taskType = await prisma.workItemType.findFirst({
    where: { isBuiltIn: true, key: "software.task" },
    select: { id: true },
  });
  if (!taskType) return; // ensureBuiltInTaskType runs first

  await prisma.$transaction(async (tx) => {
    const proj = await tx.project.create({
      data: {
        orgId,
        name: "Falcon Program",
        key: "FAL",
        description: "Seeded for @-mention E2E",
      },
    });
    const titles = [
      "Falcon radar upgrade",
      "Falcon telemetry pipeline",
      "Falcon SSO integration",
    ];
    await tx.workItem.createMany({
      data: titles.map((title, i) => ({
        orgId,
        projectId: proj.id,
        workItemTypeId: taskType.id,
        title,
        columnKey: "backlog",
        ticketNumber: i + 1,
        sortOrder: i,
        priority: "MEDIUM" as const,
        createdById: aliceId,
        tags: [] as string[],
      })),
    });
    const note = await tx.note.create({
      data: {
        orgId,
        authorId: aliceId,
        title: "Falcon plan",
        content: `Depends on <@project:${proj.id}> delivery`,
        visibility: "ORG",
      },
    });
    // A backlink so the "Mentioned in" panel has content for the backlinks E2E.
    await tx.reference.create({
      data: {
        orgId,
        sourceType: "note",
        sourceId: note.id,
        targetType: "project",
        targetId: proj.id,
        createdById: aliceId,
      },
    });
  });
}

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: "test-org" },
    update: {},
    create: {
      name: "Test Org",
      slug: "test-org",
    },
  });

  async function findOrCreateUser(email: string, displayName: string) {
    const existing = await prisma.user.findFirst({ where: { email } });
    if (existing) return existing;
    return prisma.user.create({
      data: { email, displayName, avatarUrl: null },
    });
  }

  const alice = await findOrCreateUser("alice@test.local", "Alice");
  const bob = await findOrCreateUser("bob@test.local", "Bob");

  async function upsertOrgMember(
    userId: string,
    role: "OWNER" | "ADMIN" | "MEMBER",
  ) {
    return prisma.orgMember.upsert({
      where: { orgId_userId: { orgId: org.id, userId } },
      update: { role },
      create: { orgId: org.id, userId, role },
    });
  }

  const aliceMember = await upsertOrgMember(alice.id, "ADMIN");
  const bobMember = await upsertOrgMember(bob.id, "MEMBER");

  await ensureGeneralChannel(org.id, alice.id);
  await autoJoinGeneral(org.id, alice.id, true);
  await autoJoinGeneral(org.id, bob.id, false);

  const projectId = await ensureProjectFixture(org.id, aliceMember.id);
  await ensureSecondBoard(org.id, projectId);
  await ensureBuiltInTaskType();
  await ensureMentionFixtures(org.id, alice.id);

  console.log("Seeded test fixtures:", {
    orgId: org.id,
    orgSlug: org.slug,
    aliceId: alice.id,
    bobId: bob.id,
    aliceMemberId: aliceMember.id,
    bobMemberId: bobMember.id,
    projectId,
    projectKey: "TEST",
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
