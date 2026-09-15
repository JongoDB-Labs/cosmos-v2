/**
 * Seeds a TIMELINE board carrying every plan-drift combination, so the "Plan
 * drift" lens can be checked visually instead of only through jsdom.
 *
 * {early, on-plan, late} start x {early, on-plan, late} end, plus the no-actuals
 * and no-recorded-start cases, the three colour bands, and four milestones.
 * Every span scenario shares the SAME planned span, so the marks line up in a
 * column and can be compared down the page.
 *
 * Green means ahead of plan and red means behind it; a mark is striped where it
 * overlays the solid bar and a shadow where it does not.
 *
 * Dates are stamped at 12:00 UTC: the renderer calls startOfDay() in LOCAL time,
 * so a midnight-UTC stamp lands on the previous calendar day in any negative
 * offset and every bar would sit one day left of where this file says it does.
 *
 *   npx tsx prisma/seed/drift-probe.ts
 */
import { makePrismaClient } from "./shared/prisma-client";

const prisma = makePrismaClient();

/** Midday UTC, `days` from today — see the header note on why not midnight. */
function day(offset: number): Date {
  const d = new Date();
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0);
  return new Date(utc + offset * 86_400_000);
}

// One planned span for every row.
const PLANNED_START = -30;
const PLANNED_END = -15;

const DRIFT = 5; // how far an early/late start misses the plan by
const SLIP = 7; // how far a late end slips past it

interface Scenario {
  n: number;
  label: string;
  actualStart: number | null;
  completedAt: number | null;
  /** What the lens is supposed to draw. Asserted from the DOM, not just read. */
  expect: string[];
  /** Bare type key — drives the colour band. Defaults to a delivery-blue TASK. */
  type?: "EPIC" | "FEATURE" | "TASK" | "BUG" | "MILESTONE";
  /** Milestones collapse to a single day, so start and end coincide. */
  point?: number;
}

const SCENARIOS: Scenario[] = [
  { n: 1, label: "early start / early end", actualStart: PLANNED_START - DRIFT, completedAt: PLANNED_END - DRIFT, expect: ["green", "green"] },
  { n: 2, label: "early start / on-plan end", actualStart: PLANNED_START - DRIFT, completedAt: PLANNED_END, expect: ["green"] },
  { n: 3, label: "early start / LATE end", actualStart: PLANNED_START - DRIFT, completedAt: PLANNED_END + SLIP, expect: ["green", "red"] },
  { n: 4, label: "on-plan start / early end", actualStart: PLANNED_START, completedAt: PLANNED_END - DRIFT, expect: ["green"] },
  { n: 5, label: "on-plan start / on-plan end", actualStart: PLANNED_START, completedAt: PLANNED_END, expect: [] },
  { n: 6, label: "on-plan start / LATE end", actualStart: PLANNED_START, completedAt: PLANNED_END + SLIP, expect: ["red"] },
  { n: 7, label: "LATE start / early end", actualStart: PLANNED_START + DRIFT, completedAt: PLANNED_END - DRIFT, expect: ["red"] },
  { n: 8, label: "LATE start / on-plan end", actualStart: PLANNED_START + DRIFT, completedAt: PLANNED_END, expect: ["red"] },
  { n: 9, label: "LATE start / LATE end", actualStart: PLANNED_START + DRIFT, completedAt: PLANNED_END + SLIP, expect: ["red", "red"] },
  { n: 10, label: "NO actuals at all (overdue)", actualStart: null, completedAt: null, expect: [] },
  // The shape imported work takes, and what a ticket looks like after its
  // actual_start is cleared in bulk: a known finish, no start. The slip is real
  // and used to be dropped entirely, so the bar sat on its planned dates saying
  // nothing. Row 10 is its counterweight — equally overdue, but untouched, so it
  // must stay bare.
  { n: 11, label: "finished LATE, no recorded start", actualStart: null, completedAt: PLANNED_END + SLIP, expect: ["red"] },
  // Colour bands: initiative purple vs delivery blue, on identical dates.
  { n: 12, label: "EPIC (purple band)", actualStart: PLANNED_START, completedAt: PLANNED_END + SLIP, expect: ["red"], type: "EPIC" },
  { n: 13, label: "FEATURE (purple band)", actualStart: PLANNED_START - DRIFT, completedAt: PLANNED_END, expect: ["green"], type: "FEATURE" },
  { n: 14, label: "BUG (delivery blue)", actualStart: PLANNED_START + DRIFT, completedAt: PLANNED_END - DRIFT, expect: ["red", "green"], type: "BUG" },
  // Milestones are points, so they drift by MOVING. Orange band.
  { n: 15, label: "MILESTONE on its date", actualStart: null, completedAt: PLANNED_END, expect: [], type: "MILESTONE", point: PLANNED_END },
  { n: 16, label: "MILESTONE slipped", actualStart: null, completedAt: PLANNED_END + SLIP, expect: ["red"], type: "MILESTONE", point: PLANNED_END },
  { n: 17, label: "MILESTONE pulled in", actualStart: null, completedAt: PLANNED_END - SLIP, expect: ["green"], type: "MILESTONE", point: PLANNED_END },
  { n: 18, label: "MILESTONE not reached", actualStart: null, completedAt: null, expect: [], type: "MILESTONE", point: PLANNED_END },
];

/** The catalogue types the bands key off. The CI fixture seed only creates
 *  `software.task`, so anything else this probe needs is made on demand. */
const TYPE_KEYS: Record<string, string> = {
  EPIC: "software.epic",
  FEATURE: "software.feature",
  TASK: "software.task",
  BUG: "software.bug",
  MILESTONE: "cross.milestone",
};

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" } });
  const project = await prisma.project.findFirstOrThrow({ where: { orgId: org.id, key: "TEST" } });
  const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
  const typeIds: Record<string, string> = {};
  for (const [bare, key] of Object.entries(TYPE_KEYS)) {
    const existing = await prisma.workItemType.findFirst({ where: { isBuiltIn: true, key } });
    typeIds[bare] =
      existing?.id ??
      (
        await prisma.workItemType.create({
          data: {
            orgId: null,
            key,
            name: bare[0] + bare.slice(1).toLowerCase(),
            pluralName: bare[0] + bare.slice(1).toLowerCase() + "s",
            isBuiltIn: true,
            sortOrder: 50,
          },
        })
      ).id;
  }

  // Idempotent: wipe the probe board and its items so re-running never stacks
  // a second set of ten rows on top of the first.
  const existing = await prisma.board.findFirst({
    where: { projectId: project.id, name: "Drift Probe" },
    select: { id: true },
  });
  if (existing) await prisma.board.delete({ where: { id: existing.id } });
  await prisma.workItem.deleteMany({
    where: { projectId: project.id, title: { startsWith: "DRIFT " } },
  });

  const board = await prisma.board.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      name: "Drift Probe",
      type: "TIMELINE",
      sortOrder: 2,
    },
  });

  for (const s of SCENARIOS) {
    const item = await prisma.workItem.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        workItemTypeId: typeIds[s.type ?? "TASK"],
        title: `DRIFT ${s.n}. ${s.label}`,
        columnKey: s.completedAt !== null ? "done" : "todo",
        ticketNumber: 900 + s.n,
        sortOrder: s.n,
        priority: "MEDIUM",
        createdById: alice.id,
        startDate: day(s.point ?? PLANNED_START),
        dueDate: day(s.point ?? PLANNED_END),
        actualStart: s.actualStart === null ? null : day(s.actualStart),
        completedAt: s.completedAt === null ? null : day(s.completedAt),
        tags: [],
      },
    });
    // Assigned so the board's default "Assigned to me" filter does not empty it.
    await prisma.workItemAssignee.create({
      data: { workItemId: item.id, userId: alice.id },
    });
  }

  console.log(
    JSON.stringify(
      {
        orgSlug: org.slug,
        projectKey: project.key,
        boardId: board.id,
        url: `/${org.slug}/projects/${project.key}/boards/${board.id}`,
        plannedStart: day(PLANNED_START).toISOString(),
        plannedEnd: day(PLANNED_END).toISOString(),
        expected: SCENARIOS.map((s) => ({ n: s.n, expect: s.expect })),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
