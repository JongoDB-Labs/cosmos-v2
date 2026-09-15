/**
 * Local-only: a Kanban board with a parent/child pair sitting in Backlog, to
 * replicate "the Sprint board does not allow me to move items from Backlog to
 * To Do" and to exercise the actual-date + parent-cascade dialogs.
 */
import { makePrismaClient } from "./shared/prisma-client";

const prisma = makePrismaClient();

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" } });
  const project = await prisma.project.findFirstOrThrow({
    where: { orgId: org.id, key: "TEST" },
  });
  const type = await prisma.workItemType.findFirstOrThrow({ where: { key: "software.task" } });
  const creator = await prisma.orgMember.findFirstOrThrow({ where: { orgId: org.id } });

  await prisma.workItem.deleteMany({ where: { projectId: project.id } });
  await prisma.board.deleteMany({ where: { projectId: project.id, name: "Repro Board" } });

  const board = await prisma.board.create({
    data: { orgId: org.id, projectId: project.id, name: "Repro Board", type: "KANBAN", sortOrder: 98 },
  });
  const COLS = [
    { name: "Backlog", key: "backlog", category: "TODO" as const, sortOrder: 0 },
    { name: "To Do", key: "todo", category: "TODO" as const, sortOrder: 1 },
    { name: "In Progress", key: "in-progress", category: "IN_PROGRESS" as const, sortOrder: 2 },
    { name: "Review", key: "review", category: "IN_PROGRESS" as const, sortOrder: 3 },
    { name: "Done", key: "done", category: "DONE" as const, sortOrder: 4 },
  ];
  for (const c of COLS) {
    await prisma.boardColumn.create({
      data: { boardId: board.id, color: "#94a3b8", ...c },
    });
  }

  const base = {
    orgId: org.id,
    projectId: project.id,
    workItemTypeId: type.id,
    createdById: creator.userId,
    columnKey: "backlog",
    assigneeId: creator.id,
  };
  const parent = await prisma.workItem.create({
    data: { ...base, ticketNumber: 9001, title: "PARENT epic in backlog" },
  });
  const child = await prisma.workItem.create({
    data: { ...base, ticketNumber: 9002, title: "CHILD of the backlog epic", parentId: parent.id },
  });
  const plain = await prisma.workItem.create({
    data: { ...base, ticketNumber: 9003, title: "PLAIN backlog item, no parent" },
  });

  console.log(`board=${board.id} parent=${parent.id} child=${child.id} plain=${plain.id}`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(e); await prisma.$disconnect(); process.exit(1);
});
