/** Local-only: a SCRUM (Sprint) board with an active interval, mirroring the
 *  shape of the board the report came from. */
import { makePrismaClient } from "./shared/prisma-client";
const prisma = makePrismaClient();

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" } });
  const project = await prisma.project.findFirstOrThrow({ where: { orgId: org.id, key: "TEST" } });
  const type = await prisma.workItemType.findFirstOrThrow({ where: { key: "software.task" } });
  const creator = await prisma.orgMember.findFirstOrThrow({ where: { orgId: org.id } });

  await prisma.board.deleteMany({ where: { projectId: project.id, name: "Sprint Repro" } });
  await prisma.workItem.deleteMany({ where: { projectId: project.id, ticketNumber: { gte: 9100 } } });

  const board = await prisma.board.create({
    data: { orgId: org.id, projectId: project.id, name: "Sprint Repro", type: "SCRUM", sortOrder: 97 },
  });
  for (const c of [
    { name: "Backlog", key: "backlog", category: "TODO" as const, sortOrder: 0 },
    { name: "To Do", key: "todo", category: "TODO" as const, sortOrder: 1 },
    { name: "In Progress", key: "in-progress", category: "IN_PROGRESS" as const, sortOrder: 2 },
    { name: "Review", key: "review", category: "IN_PROGRESS" as const, sortOrder: 3 },
    { name: "Done", key: "done", category: "DONE" as const, sortOrder: 4 },
  ]) {
    await prisma.boardColumn.create({ data: { boardId: board.id, color: "#94a3b8", ...c } });
  }

  const maxN = await prisma.interval.aggregate({ where: { projectId: project.id }, _max: { number: true } });
  const interval = await prisma.interval.create({
    data: {
      orgId: org.id, projectId: project.id, intervalKind: "SPRINT",
      number: (maxN._max.number ?? 0) + 1, name: "Active Sprint", status: "ACTIVE",
      startDate: new Date(Date.now() - 5 * 864e5), endDate: new Date(Date.now() + 9 * 864e5),
    },
  });

  const base = {
    orgId: org.id, projectId: project.id, workItemTypeId: type.id,
    createdById: creator.userId, assigneeId: creator.id, intervalId: interval.id,
  };
  const made: Record<string, string> = {};
  let n = 9100;
  for (const [key, count] of [["backlog", 3], ["todo", 3], ["in-progress", 2], ["done", 2]] as const) {
    for (let i = 0; i < count; i++) {
      const it = await prisma.workItem.create({
        data: { ...base, ticketNumber: n++, title: `${key} item ${i + 1}`, columnKey: key },
      });
      if (i === 0) made[key] = it.id;
    }
  }
  console.log(`board=${board.id} interval=${interval.id} fromBacklog=${made.backlog} fromDone=${made.done} fromInProgress=${made["in-progress"]}`);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
