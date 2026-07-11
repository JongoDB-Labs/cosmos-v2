import { describe, it, expect } from "vitest";
import { parseCSV } from "./csv";
import {
  COSMOS_CSV_HEADERS,
  cosmosItemToRow,
  cycleKindLabel,
  issueToCosmosItem,
  milestoneToCosmosItem,
  objectiveToCosmosItem,
  serializeCosmosCsv,
  sprintToCosmosItem,
  toDay,
  type CosmosItem,
} from "./cosmos-schema";

describe("toDay", () => {
  it("slices an ISO string to yyyy-mm-dd", () => {
    expect(toDay("2026-07-11T13:45:00.000Z")).toBe("2026-07-11");
  });
  it("formats a Date to its UTC day", () => {
    expect(toDay(new Date("2026-01-02T23:00:00.000Z"))).toBe("2026-01-02");
  });
  it("returns null for null / undefined / empty", () => {
    expect(toDay(null)).toBeNull();
    expect(toDay(undefined)).toBeNull();
    expect(toDay("")).toBeNull();
  });
});

describe("cycleKindLabel", () => {
  it("humanises known cycle kinds", () => {
    expect(cycleKindLabel("SPRINT")).toBe("Sprint");
    expect(cycleKindLabel("PROGRAM_INCREMENT")).toBe("Program Increment");
  });
  it("falls back to the raw value for unknown kinds", () => {
    expect(cycleKindLabel("WEIRD")).toBe("WEIRD");
  });
});

describe("per-kind mappers → the common schema", () => {
  it("maps an issue onto issue-only fields (priority, story points, tags, key)", () => {
    const item = issueToCosmosItem({
      id: "i1",
      ticketKey: "VITL-12",
      title: "Fix login",
      typeName: "Bug",
      columnKey: "in-progress",
      priority: "HIGH",
      assigneeName: "Ada Lovelace",
      projectName: "Platform",
      parentKey: "VITL-1",
      storyPoints: 5,
      tags: ["auth", "urgent"],
      startDate: "2026-07-01T00:00:00.000Z",
      dueDate: "2026-07-15T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    expect(item).toMatchObject({
      kind: "issue",
      key: "VITL-12",
      type: "Bug",
      status: "in-progress",
      priority: "HIGH",
      owner: "Ada Lovelace",
      project: "Platform",
      parent: "VITL-1",
      storyPoints: 5,
      tags: ["auth", "urgent"],
      startDate: "2026-07-01",
      dueDate: "2026-07-15",
      completedAt: null,
      progress: null,
    });
  });

  it("maps an objective onto progress + target date, leaving issue-only fields blank", () => {
    const item = objectiveToCosmosItem({
      id: "o1",
      title: "Grow activation",
      description: "North-star objective",
      status: "ACTIVE",
      progress: 42,
      ownerName: "Grace Hopper",
      projectName: "Growth",
      parentTitle: "Company OKRs",
      targetDate: new Date("2026-09-30T00:00:00.000Z"),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(item).toMatchObject({
      kind: "objective",
      title: "Grow activation",
      type: "Objective",
      status: "ACTIVE",
      progress: 42,
      owner: "Grace Hopper",
      parent: "Company OKRs",
      description: "North-star objective",
      dueDate: "2026-09-30",
      // issue-only fields blank
      priority: "",
      storyPoints: null,
      tags: [],
      key: "",
    });
  });

  it("maps a milestone onto due/completed dates", () => {
    const item = milestoneToCosmosItem({
      id: "m1",
      title: "Beta launch",
      status: "COMPLETED",
      ownerName: "Katherine Johnson",
      projectName: "Platform",
      dueDate: "2026-05-01T00:00:00.000Z",
      completedAt: "2026-04-28T00:00:00.000Z",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
    });
    expect(item).toMatchObject({
      kind: "milestone",
      type: "Milestone",
      status: "COMPLETED",
      owner: "Katherine Johnson",
      dueDate: "2026-05-01",
      completedAt: "2026-04-28",
      priority: "",
      progress: null,
    });
  });

  it("maps a sprint onto start/end + goal, with no updated date", () => {
    const item = sprintToCosmosItem({
      id: "s1",
      name: "Sprint 7",
      cycleKind: "SPRINT",
      status: "ACTIVE",
      goal: "Ship export",
      projectName: "Platform",
      parentName: "PI-2",
      startDate: "2026-07-07T00:00:00.000Z",
      endDate: "2026-07-21T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    expect(item).toMatchObject({
      kind: "sprint",
      title: "Sprint 7",
      type: "Sprint",
      status: "ACTIVE",
      description: "Ship export",
      parent: "PI-2",
      startDate: "2026-07-07",
      dueDate: "2026-07-21",
      updatedAt: null,
      completedAt: null,
    });
  });
});

describe("serializeCosmosCsv", () => {
  const issue = issueToCosmosItem({
    id: "i1",
    ticketKey: "VITL-12",
    title: "Fix login",
    typeName: "Bug",
    columnKey: "todo",
    priority: "HIGH",
    projectName: "Platform",
    tags: ["a", "b"],
  });
  const objective = objectiveToCosmosItem({
    id: "o1",
    title: "Grow activation",
    status: "ACTIVE",
    progress: 42,
    projectName: "Growth",
  });

  it("emits a header-only CSV for an empty result set (no error, still well-formed)", () => {
    const csv = serializeCosmosCsv([]);
    expect(csv).toBe(COSMOS_CSV_HEADERS.join(","));
    const parsed = parseCSV(csv);
    expect(parsed.headers).toEqual(COSMOS_CSV_HEADERS);
    expect(parsed.rows).toEqual([]);
  });

  it("writes one row per item with all columns in schema order", () => {
    const csv = serializeCosmosCsv([issue, objective]);
    const parsed = parseCSV(csv);
    expect(parsed.headers).toEqual(COSMOS_CSV_HEADERS);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].Kind).toBe("Issue");
    expect(parsed.rows[0].Key).toBe("VITL-12");
    expect(parsed.rows[0].Priority).toBe("HIGH");
    expect(parsed.rows[0].Tags).toBe("a; b");
    expect(parsed.rows[0].Progress).toBe(""); // blank for an issue
    expect(parsed.rows[1].Kind).toBe("Objective");
    expect(parsed.rows[1].Progress).toBe("42");
    expect(parsed.rows[1].Priority).toBe(""); // blank for an objective
  });

  it("escapes commas / quotes / newlines so the CSV stays parseable", () => {
    const tricky: CosmosItem = issueToCosmosItem({
      id: "i2",
      ticketKey: "VITL-99",
      title: 'Comma, "quote" and\nnewline',
      typeName: "Story",
      columnKey: "todo",
      priority: "LOW",
      projectName: "Platform",
    });
    const parsed = parseCSV(serializeCosmosCsv([tricky]));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].Title).toBe('Comma, "quote" and\nnewline');
  });

  it("handles a large item count without truncating rows", () => {
    const many = Array.from({ length: 10_000 }, (_, n) =>
      issueToCosmosItem({
        id: `i${n}`,
        ticketKey: `VITL-${n}`,
        title: `Item ${n}`,
        typeName: "Task",
        columnKey: "todo",
        priority: "MEDIUM",
        projectName: "Platform",
      }),
    );
    const parsed = parseCSV(serializeCosmosCsv(many));
    expect(parsed.rows).toHaveLength(10_000);
    expect(parsed.rows[9_999].Key).toBe("VITL-9999");
  });
});

describe("cosmosItemToRow", () => {
  it("produces a cell for every schema column", () => {
    const row = cosmosItemToRow(
      objectiveToCosmosItem({ id: "o1", title: "T", status: "ACTIVE", projectName: "P" }),
    );
    expect(Object.keys(row)).toEqual(COSMOS_CSV_HEADERS);
  });
});
