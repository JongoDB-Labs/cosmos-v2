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
import { Prisma, type BoardType } from "@prisma/client";
import { makePrismaClient } from "./shared/prisma-client";
import { ensureSeedStatuses } from "./shared/statuses";
import { BOARD_TYPE_REGISTRY } from "../../src/lib/boards/board-types";
import { DEFAULT_COLUMNS } from "../../src/lib/boards/default-columns";
import { DEFAULT_CATEGORIES } from "../../src/lib/program-calendar/categories";

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
  if (existing) {
    await ensureSeedStatuses(prisma, existing.id);
    return existing.id;
  }

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
    // Each column's status: a work item's columnKey must name one.
    await ensureSeedStatuses(tx, proj.id);
    // ProjectMember.orgMemberId references OrgMember.id (NOT User.id).
    await tx.projectMember.create({
      data: { projectId: proj.id, orgMemberId: aliceMemberId, role: "MANAGER" },
    });
    return proj.id;
  });
}

/**
 * Seed a SECOND board on the TEST project so the board-switching E2E journey has
 * two tabs to toggle between. Distinct name ("Roadmap") so the two tabs are
 * unambiguous, and sortOrder 1 so it stays AFTER the default KANBAN
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

const GALLERY_KEY = "GALLERY";

/**
 * The types whose columns ARE the project's workflow — `SEEDED_FROM_PROJECT` in
 * `src/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/route.ts`.
 */
const SEEDED_FROM_WORKFLOW = new Set<BoardType>(["KANBAN", "SCRUM"]);

/**
 * Every board in the gallery. One per `BoardType`, plus a second TIMELINE for
 * its Release Timeline variant, so sixteen rows for fifteen types.
 */
const GALLERY_BOARDS: {
  slug: string;
  name: string;
  type: BoardType;
  config?: Record<string, string>;
}[] = [
  { slug: "kanban", name: "Kanban", type: "KANBAN" },
  { slug: "scrum", name: "Scrum", type: "SCRUM" },
  { slug: "sprint-planning", name: "Sprint Planning", type: "SPRINT_PLANNING" },
  { slug: "sprint-review", name: "Sprint Review", type: "SPRINT_REVIEW" },
  { slug: "backlog", name: "Backlog", type: "BACKLOG" },
  { slug: "table", name: "Table", type: "TABLE" },
  { slug: "calendar", name: "Calendar", type: "CALENDAR" },
  { slug: "timeline", name: "Timeline", type: "TIMELINE" },
  // Same board TYPE as above, second variant: config.mode picks the static
  // Release Timeline snapshot over the interactive Gantt (board-renderer.tsx).
  {
    slug: "release-timeline",
    name: "Release Timeline",
    type: "TIMELINE",
    config: { mode: "release-timeline" },
  },
  { slug: "roadmap", name: "Roadmap", type: "ROADMAP" },
  { slug: "okrs", name: "OKRs", type: "OKR" },
  { slug: "dashboard", name: "Dashboard", type: "DASHBOARD" },
  { slug: "portfolio", name: "Portfolio", type: "PORTFOLIO" },
  { slug: "program", name: "Program", type: "PROGRAM" },
  { slug: "raid", name: "RAID Log", type: "RAID" },
  { slug: "cfd", name: "Cumulative Flow", type: "CFD" },
];

/**
 * The board gallery: one project carrying a board of EVERY BoardType, each on a
 * fixed slug, plus just enough data (one active sprint, four work items) for the
 * views to render their real chrome instead of an empty state.
 *
 * Exists because `e2e/a11y.spec.ts` could only ever reach ONE board view. Its
 * route list goes through `/projects/{KEY}`, which redirects to the TEST
 * project's default board, and both of TEST's seeded boards are KANBAN — so no
 * Calendar, Scrum, Table, Timeline, Roadmap, OKR, Dashboard, RAID, CFD or
 * ceremony board had ever been scanned.
 *
 * Why its own project rather than folding the boards into TEST: sixteen more
 * tabs and four more items on TEST would move the DOM under the dozen mutating
 * journeys that count its items and read its board tab strip. The gallery is
 * read-only by contract — the only spec that opens it is the a11y scan.
 *
 * Slugs, not ids: `/projects/{key}/boards/{segment}` resolves a slug as well as
 * a UUID (`boards/[boardId]/page.tsx`), so a seeded slug gives the spec a
 * STATIC URL per board type with no id to look up at runtime. The spec asserts
 * the URL does not move, so renaming a slug here fails there rather than
 * silently scanning a 404.
 *
 * Idempotent on the project key.
 */
async function ensureBoardGallery(
  orgId: string,
  aliceMemberId: string,
  aliceUserId: string,
): Promise<void> {
  const existing = await prisma.project.findFirst({
    where: { orgId, key: GALLERY_KEY },
    select: { id: true },
  });
  if (existing) return;

  const taskType = await prisma.workItemType.findFirst({
    where: { isBuiltIn: true, key: "software.task" },
    select: { id: true },
  });
  if (!taskType) return; // ensureBuiltInTaskType runs first

  // Relative to the seed run, not fixed calendar dates: the Scrum and ceremony
  // boards report on a sprint that is ACTIVE *now*, so a hardcoded window would
  // age out of ACTIVE and leave them on an empty state.
  const day = 24 * 60 * 60 * 1000;
  const now = new Date();
  const at = (days: number) => new Date(now.getTime() + days * day);
  // Work-item dates are pinned to a DAY OF THE CURRENT UTC MONTH instead, for
  // one reason: the Calendar board opens on the current month, so a `now + 11
  // days` due date falls off the visible grid whenever the seed runs in the last
  // third of a month — the items would silently vanish from that board on some
  // days and not others, and the a11y scan anchors on seeing one. Days 7–16 are
  // inside every month, February included. (CI runs UTC; UTC here too, so a
  // local-time box agrees with it.)
  const inMonth = (dayOfMonth: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dayOfMonth, 12));

  const projectId = await prisma.$transaction(async (tx) => {
    const proj = await tx.project.create({
      data: {
        orgId,
        name: "Board Gallery",
        key: GALLERY_KEY,
        description: "One board of every type, for the e2e a11y scan",
      },
    });

    // Boards first, statuses after: `ensureSeedStatuses` derives the project's
    // workflow_statuses FROM its boards' columns, and those statuses are what
    // every other board's Status filter and done-ness check reads. Seed the
    // items before the statuses exist and their columnKey FK fails; seed the
    // statuses before the Kanban board and there is nothing to derive them from
    // (the empty-`board.columns` trap, from the other end).
    for (const [i, b] of GALLERY_BOARDS.entries()) {
      await tx.board.create({
        data: {
          orgId,
          projectId: proj.id,
          name: b.name,
          slug: b.slug,
          type: b.type,
          sortOrder: i,
          config: (b.config ?? {}) as Prisma.InputJsonValue,
          // Mirrors what POST /boards does, so the gallery is not a shape the
          // product never makes: KANBAN and SCRUM start from the project's
          // workflow, the ceremony types get the registry's prompt columns
          // (Start/Stop/Continue, Risks/Questions/Decisions), and the rest own
          // none — Calendar, Table, Timeline and Roadmap genuinely have zero.
          columns: {
            create: (SEEDED_FROM_WORKFLOW.has(b.type)
              ? DEFAULT_COLUMNS.map(({ name, key, color, category }) => ({ name, key, color, category }))
              : (BOARD_TYPE_REGISTRY[b.type].defaultColumns ?? [])
            ).map((c, j) => ({ ...c, sortOrder: j })),
          },
        },
      });
    }
    await ensureSeedStatuses(tx, proj.id);
    await tx.projectMember.create({
      data: { projectId: proj.id, orgMemberId: aliceMemberId, role: "MANAGER" },
    });

    // One ACTIVE sprint inside a PROGRAM_INCREMENT: the Scrum board scopes to
    // the active sprint, the ceremony boards report on one, and the Roadmap
    // counts increments.
    const pi = await tx.interval.create({
      data: {
        orgId,
        projectId: proj.id,
        intervalKind: "PROGRAM_INCREMENT",
        number: 1,
        name: "PI 1",
        startDate: at(-14),
        endDate: at(56),
        status: "ACTIVE",
      },
    });
    const sprint = await tx.interval.create({
      data: {
        orgId,
        projectId: proj.id,
        intervalKind: "SPRINT",
        // `number` is unique per PROJECT, not per kind, so the sprint cannot
        // reuse the PI's 1 — the first attempt here died on P2002.
        number: 2,
        name: "Sprint 1",
        goal: "Render every board type",
        startDate: at(-7),
        endDate: at(7),
        status: "ACTIVE",
        parentId: pi.id,
      },
    });

    // Four items, one per non-terminal status, all in the active sprint. Two
    // carry RAID tags so the RAID log has classified cards as well as
    // unclassified ones, and each sits on its own day so the Calendar renders
    // one cell per item rather than a "+N more" rollup.
    const items: {
      title: string;
      columnKey: string;
      tags: string[];
      /** Day of the current month. Start is three days earlier. */
      due: number;
    }[] = [
      { title: "Gallery item in backlog", columnKey: "backlog", tags: ["risk"], due: 10 },
      { title: "Gallery item in to do", columnKey: "todo", tags: ["dependency"], due: 12 },
      { title: "Gallery item in progress", columnKey: "in-progress", tags: [], due: 14 },
      { title: "Gallery item in review", columnKey: "review", tags: [], due: 16 },
    ];
    await tx.workItem.createMany({
      data: items.map((it, i) => ({
        orgId,
        projectId: proj.id,
        workItemTypeId: taskType.id,
        title: it.title,
        columnKey: it.columnKey,
        ticketNumber: i + 1,
        sortOrder: i,
        priority: "MEDIUM" as const,
        storyPoints: i + 1,
        intervalId: sprint.id,
        assigneeId: aliceUserId,
        startDate: inMonth(it.due - 3),
        dueDate: inMonth(it.due),
        createdById: aliceUserId,
        tags: it.tags,
      })),
    });
    return proj.id;
  });

  console.log("Seeded board gallery:", { projectId, projectKey: GALLERY_KEY });
}

/**
 * The program calendar, switched on for the gallery and given events to draw.
 *
 * The calendar (`/projects/{key}/pm-dashboard/calendar`) is not a board, so the
 * gallery above never reached it, and nothing in this seed created a program
 * event, so a scan of it in CI would have been a scan of an empty grid. That
 * is how serious axe violations on it reached a merged PR unseen.
 *
 * What the events are for, since each one is there to put a piece of markup on
 * screen that the a11y scan would otherwise never see:
 *   - one per default category, because the chip's ink and tint come from the
 *     category, so each category is its own contrast pair;
 *   - a multi-day event across a week boundary, for the continuation arrows;
 *   - a timed event, for the time prefix the chip renders in a lighter weight;
 *   - four events on the 10th, one more than the month view shows in a cell,
 *     for the "+N more" overflow button.
 * Days 7–16 of the current UTC month, like the gallery's work items, so they
 * are on the month the calendar opens to.
 *
 * Linked to the gallery project rather than org-level, and the gallery is the
 * project whose PM Dashboard gets the Program Calendar sub-tab: TEST is the
 * target of mutating journeys that read its tab strip. Events are ORG-scoped
 * on the calendar itself, so they show on every project's calendar in this
 * org; nothing else renders program events.
 *
 * Separate from `ensureBoardGallery`, which returns early once the gallery
 * exists, so re-running the seed adds this to an existing database too.
 * Idempotent: events upsert on `externalId`, which also moves them onto the
 * current month on a re-run.
 */
async function ensureProgramCalendarFixture(orgId: string, aliceUserId: string): Promise<void> {
  const gallery = await prisma.project.findFirst({
    where: { orgId, key: GALLERY_KEY },
    select: { id: true, enabledFeatures: true },
  });
  if (!gallery) return;

  // The calendar is a sub-tab of the PM Dashboard; both flags, or the tab that
  // leads to it is not in the nav (pm-dashboard/pm-nav.tsx).
  const features = new Set([...gallery.enabledFeatures, "pm-dashboard", "program-calendar"]);
  if (features.size !== gallery.enabledFeatures.length) {
    await prisma.project.update({
      where: { id: gallery.id },
      data: { enabledFeatures: [...features] },
    });
  }

  // What `listCategories` does on an org's first visit, so the seeded rows are
  // the ones the product would have made.
  await prisma.eventCategory.createMany({
    data: DEFAULT_CATEGORIES.map((c, i) => ({ ...c, orgId, sortOrder: i })),
    skipDuplicates: true,
  });
  const categories = await prisma.eventCategory.findMany({
    where: { orgId, name: { in: DEFAULT_CATEGORIES.map((c) => c.name) } },
    select: { id: true, name: true },
  });
  const categoryId = (name: string) => {
    const hit = categories.find((c) => c.name === name);
    if (!hit) throw new Error(`event category "${name}" missing after createMany`);
    return hit.id;
  };

  const now = new Date();
  const day = (d: number, hour = 0) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d, hour));

  // The layout is built for the a11y gate (e2e/a11y.spec.ts), which pins the
  // browser clock to each "pin day" in turn so that day is TODAY: its column
  // gets the `bg-primary/5` tint, a different ground from every other day, and
  // the one a chip is most likely to fail on. Every category must reach that
  // ground on some pin day, and WHICH chips render there must not depend on
  // anything the seed cannot fix.
  //
  // That rules out four events of different categories on one day. The month
  // grid shows three lanes; the fourth event becomes "+1 more", and for
  // same-length events on the same day `packWeek` breaks the tie by event id —
  // a random uuid. CI and a local DB then scanned different chips, and the gate
  // passed or failed by which one happened to be hidden. So:
  //   - pin days 3 and 6 hold exactly three single-day events each, all of
  //     different categories, so all three always fit;
  //   - pin day 10 holds the overflow, and all four of its events share ONE
  //     category, so the hidden one changes nothing that is scanned;
  //   - pin day 17 starts the multi-day bar (its title sits over the day it
  //     starts on) beside one single-day event. The bar runs eight days, so it
  //     always crosses a week and draws its continuation arrows, and nothing
  //     else is seeded on the days it covers.
  // Days 3-24 exist in every month, whatever weekday the month starts on.
  //
  // All-day events are stored UTC midnight to UTC midnight, end EXCLUSIVE.
  const events: { key: string; title: string; category: string; startsAt: Date; endsAt: Date; allDay: boolean }[] = [
    // Pin day 3.
    { key: "contracts", title: "Gallery contract award", category: "Contracts", startsAt: day(3), endsAt: day(4), allDay: true },
    { key: "deliverables", title: "Gallery deliverable due", category: "Deliverables", startsAt: day(3), endsAt: day(4), allDay: true },
    { key: "governance", title: "Gallery decision board", category: "Governance & Decisions", startsAt: day(3), endsAt: day(4), allDay: true },
    // Pin day 6. The timed chip leads with its start time, a second text node.
    { key: "milestones", title: "Gallery milestone", category: "Milestones", startsAt: day(6), endsAt: day(7), allDay: true },
    { key: "rhythm", title: "Gallery business rhythm", category: "Business Rhythm", startsAt: day(6, 9), endsAt: day(6, 10), allDay: false },
    { key: "reviews", title: "Gallery sprint demo", category: "Reviews & Demos", startsAt: day(6), endsAt: day(7), allDay: true },
    // Pin day 10: four events, three lanes, "+1 more" on today's column.
    ...[1, 2, 3, 4].map((n) => ({
      key: n === 1 ? "staffing" : `staffing-${n}`,
      title: `Gallery staffing review ${n}`,
      category: "Staffing",
      startsAt: day(10),
      endsAt: day(11),
      allDay: true,
    })),
    // Pin day 17.
    { key: "engagements", title: "Gallery site engagement", category: "Engagements", startsAt: day(17), endsAt: day(25), allDay: true },
    { key: "cadence", title: "Gallery delivery cadence", category: "Delivery Cadence", startsAt: day(17), endsAt: day(18), allDay: true },
  ];

  for (const e of events) {
    const externalId = `e2e-gallery-${e.key}`;
    const data = {
      title: e.title,
      categoryId: categoryId(e.category),
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      allDay: e.allDay,
      // UTC so the timed chip reads "09:00" on every machine.
      timeZone: "UTC",
      projectId: gallery.id,
    };
    await prisma.programEvent.upsert({
      where: { orgId_externalId: { orgId, externalId } },
      update: data,
      create: { ...data, orgId, externalId, createdById: aliceUserId },
    });
  }

  console.log("Seeded program calendar:", { projectKey: GALLERY_KEY, events: events.length });
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
    // No board here, so the one status the items use is made directly.
    await ensureSeedStatuses(tx, proj.id, [{ key: "backlog", name: "Backlog", category: "TODO" }]);
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

/**
 * An org chart, so the timesheet approval JOURNEY is reachable at all.
 *
 * Without employee records nobody has a supervisor, submissions fall to the
 * approver pool, and — because alice is the only person holding TIME_APPROVE and
 * a worker is never routed to themselves — a submitted week is routed to NOBODY.
 * That is a legitimate state the product handles, but it means the routing and
 * notification paths cannot be exercised end to end.
 *
 * bob supervises alice. Deliberately that direction: alice is the ADMIN the
 * specs sign in as, so making HER the one with a supervisor is what exercises
 * "submitted to a named person". bob needs no TIME_APPROVE — supervising a
 * report confers approval authority on its own (see approvalAuthority).
 *
 * CAROL EXISTS TO BE BLOCKED, and a third person is genuinely required for it.
 * The submit gate refuses an unsupervised employee only when somebody COULD
 * supervise them, and neither of the other two qualifies for the other:
 * `assignableSupervisors` excludes anyone who reports up through you, so alice
 * is not offerable to bob (she reports to him) and bob holds no TIME_APPROVE.
 * With only alice and bob, every worker lands on an EXEMPTION and the block is
 * unreachable end to end. carol is an employee, unsupervised, and alice is
 * assignable to her — the one shape that is actually blocked.
 *
 * Idempotent: employees are unique on (orgId, userId).
 */
async function ensureOrgChart(
  orgId: string,
  aliceId: string,
  bobId: string,
  carolId: string,
): Promise<void> {
  const bobEmployee = await prisma.employee.upsert({
    where: { orgId_userId: { orgId, userId: bobId } },
    update: {},
    create: {
      orgId,
      userId: bobId,
      employmentType: "SALARY",
      costRate: "95.0000",
      createdById: aliceId,
    },
  });

  const aliceEmployee = await prisma.employee.upsert({
    where: { orgId_userId: { orgId, userId: aliceId } },
    update: {},
    create: {
      orgId,
      userId: aliceId,
      employmentType: "SALARY",
      costRate: "125.0000",
      createdById: aliceId,
    },
  });

  // The supervisor edge lives in `employee_supervisors`, NOT `Employee.managerId`
  // — that column is deprecated and nothing reads it. Writing the old one here
  // would seed a chart the product cannot see.
  await prisma.employeeSupervisor.upsert({
    where: {
      employeeId_supervisorId: {
        employeeId: aliceEmployee.id,
        supervisorId: bobEmployee.id,
      },
    },
    update: {},
    create: {
      orgId,
      employeeId: aliceEmployee.id,
      supervisorId: bobEmployee.id,
      createdById: aliceId,
    },
  });

  // carol: an employee with NO supervisor edge, deliberately. She is the only
  // person in this fixture the submit gate actually blocks.
  await prisma.employee.upsert({
    where: { orgId_userId: { orgId, userId: carolId } },
    update: {},
    create: {
      orgId,
      userId: carolId,
      employmentType: "HOURLY",
      costRate: "70.0000",
      createdById: aliceId,
    },
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
  // Exists to be BLOCKED by the submit gate — see ensureOrgChart.
  const carol = await findOrCreateUser("carol@test.local", "Carol");

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
  // MEMBER, so she holds no TIME_APPROVE and cannot self-approve her way out
  // of the block — the exemption that would otherwise let her through.
  await upsertOrgMember(carol.id, "MEMBER");

  await ensureGeneralChannel(org.id, alice.id);
  await autoJoinGeneral(org.id, alice.id, true);
  await autoJoinGeneral(org.id, bob.id, false);

  const projectId = await ensureProjectFixture(org.id, aliceMember.id);
  await ensureSecondBoard(org.id, projectId);
  await ensureBuiltInTaskType();
  await ensureBoardGallery(org.id, aliceMember.id, alice.id);
  await ensureProgramCalendarFixture(org.id, alice.id);
  await ensureMentionFixtures(org.id, alice.id);
  await ensureOrgChart(org.id, alice.id, bob.id, carol.id);

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
