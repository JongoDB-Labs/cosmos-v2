import { describe, it, expect } from "vitest";
import { toolCallToArtifact, artifactsFromToolCalls } from "./artifacts";

const ORG = { orgSlug: "acme" };

describe("toolCallToArtifact — mutating tool results become linked cards", () => {
  it("create_work_item → linked card deep-linking by id (no project key needed)", () => {
    const a = toolCallToArtifact(
      {
        id: "tc1",
        name: "create_work_item",
        arguments: { projectId: "p-uuid", title: "Fix login" },
        result: { created: true, id: "wi-123", ticketNumber: 42, title: "Fix login bug" },
      },
      ORG,
    );
    expect(a).toMatchObject({
      toolCallId: "tc1",
      entityType: "workItem",
      action: "created",
      id: "wi-123",
      typeLabel: "Work item",
      url: "/acme/issues?item=wi-123",
    });
    // ticket + title compose the label.
    expect(a?.label).toBe("#42 Fix login bug");
  });

  it("create_project → link uses the project KEY from the args", () => {
    const a = toolCallToArtifact(
      {
        id: "tc2",
        name: "create_project",
        arguments: { name: "Apollo", key: "APOLLO" },
        // executor nests `project` but selects only id/archived/timestamps (no key).
        result: { created: true, id: "proj-1", project: { id: "proj-1", archived: false } },
      },
      ORG,
    );
    expect(a).toMatchObject({
      entityType: "project",
      action: "created",
      label: "Apollo",
      url: "/acme/projects/APOLLO",
    });
  });

  it("create_note → linked via the ?note= focus param (id only)", () => {
    const a = toolCallToArtifact(
      { id: "tc3", name: "create_note", result: { created: true, id: "n-9", title: "Kickoff notes" } },
      ORG,
    );
    expect(a?.url).toBe("/acme/notes?note=n-9");
    expect(a?.label).toBe("Kickoff notes");
  });

  it("delete_work_item → card present but NOT linked (entity is gone)", () => {
    const a = toolCallToArtifact(
      {
        id: "tc4",
        name: "delete_work_item",
        arguments: { itemId: "wi-5" },
        result: { deleted: true, id: "wi-5", ticketNumber: 5, title: "Old task" },
      },
      ORG,
    );
    expect(a?.action).toBe("deleted");
    expect(a?.url).toBeNull();
    expect(a?.label).toBe("#5 Old task");
  });

  it("create_objective → card present, un-linked (project-scoped URL needs a key it doesn't have)", () => {
    const a = toolCallToArtifact(
      {
        id: "tc5",
        name: "create_objective",
        arguments: { projectId: "p-uuid", title: "Grow ARR" },
        result: { created: true, id: "obj-1", objective: { id: "obj-1", projectId: "p-uuid" } },
      },
      ORG,
    );
    expect(a).toMatchObject({ entityType: "objective", action: "created", label: "Grow ARR" });
    expect(a?.url).toBeNull(); // no project key available → graceful non-link
  });

  it("update_work_item → uses the id the user passed when the result omits it", () => {
    const a = toolCallToArtifact(
      {
        id: "tc6",
        name: "update_work_item",
        arguments: { id: "wi-77", status: "IN_PROGRESS" },
        result: { updated: true, id: "wi-77", ticketNumber: 77, title: "Ship it" },
      },
      ORG,
    );
    expect(a).toMatchObject({ action: "updated", id: "wi-77", url: "/acme/issues?item=wi-77" });
  });

  it("returns null for a FAILED mutation (error result, no id)", () => {
    expect(
      toolCallToArtifact(
        { id: "tc7", name: "create_work_item", result: { error: "Project not found" } },
        ORG,
      ),
    ).toBeNull();
  });

  it("returns null for a READ tool (list_projects) — no card for queries", () => {
    expect(
      toolCallToArtifact(
        { id: "tc8", name: "list_projects", result: { count: 3, projects: [] } },
        ORG,
      ),
    ).toBeNull();
  });

  it("returns null for an unmapped mutating tool (create_interval)", () => {
    expect(
      toolCallToArtifact(
        { id: "tc9", name: "create_interval", result: { created: true, id: "cy-1" } },
        ORG,
      ),
    ).toBeNull();
  });

  it("falls back to a short-id label when no title/name is available", () => {
    const a = toolCallToArtifact(
      { id: "tc10", name: "update_kpi", arguments: { id: "kpi-abcdef123" }, result: { updated: true, id: "kpi-abcdef123" } },
      ORG,
    );
    expect(a?.label).toBe("KPI kpi-abcd");
  });
});

describe("artifactsFromToolCalls", () => {
  it("keeps only the artifact-producing calls, in order", () => {
    const arts = artifactsFromToolCalls(
      [
        { id: "a", name: "list_work_items", result: { count: 1, items: [] } },
        { id: "b", name: "create_work_item", result: { created: true, id: "wi-1", ticketNumber: 1, title: "One" } },
        { id: "c", name: "create_note", result: { created: true, id: "n-1", title: "Two" } },
      ],
      ORG,
    );
    expect(arts.map((a) => a.id)).toEqual(["wi-1", "n-1"]);
  });

  it("is empty for undefined / empty input", () => {
    expect(artifactsFromToolCalls(undefined, ORG)).toEqual([]);
    expect(artifactsFromToolCalls([], ORG)).toEqual([]);
  });
});
