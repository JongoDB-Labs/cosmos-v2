import { describe, it, expect } from "vitest";
import type { WorkItem } from "@prisma/client";
import { copyFields } from "./copy-fields";

const source = {
  id: "w1",
  workItemTypeId: "task",
  description: "d",
  columnKey: "todo",
  assigneeId: "ann",
  priority: "HIGH",
  intervalId: "i1",
  parentId: "p1",
  teamId: "t1",
  storyPoints: 3,
  dueDate: new Date("2026-11-01"),
  startDate: new Date("2026-10-25"),
  workCategory: "BUSINESS",
  highlight: "red",
  tags: ["ops"],
  customFields: { env: "prod" },
  actualStart: new Date("2026-10-26"),
  completedAt: new Date("2026-10-30"),
  cancelReason: "OBE",
  mergedIntoId: "w9",
  externalId: "JIRA-1",
  ticketNumber: 7,
} as unknown as WorkItem;

describe("copyFields", () => {
  it("carries the planning fields, team and highlight included", () => {
    expect(copyFields(source)).toMatchObject({
      workItemTypeId: "task",
      description: "d",
      columnKey: "todo",
      assigneeId: "ann",
      priority: "HIGH",
      intervalId: "i1",
      parentId: "p1",
      teamId: "t1",
      storyPoints: 3,
      workCategory: "BUSINESS",
      highlight: "red",
      tags: ["ops"],
      customFields: { env: "prod" },
    });
  });

  it("never carries identity, the run so far or another system's id", () => {
    const out = copyFields(source) as Record<string, unknown>;
    for (const k of ["id", "ticketNumber", "actualStart", "completedAt", "cancelReason", "mergedIntoId", "externalId"]) {
      expect(out).not.toHaveProperty(k);
    }
  });
});
