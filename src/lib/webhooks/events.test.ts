import { describe, it, expect } from "vitest";
import { WEBHOOK_EVENTS, webhookEventsFor } from "./events";

describe("webhookEventsFor", () => {
  it("names creates and field changes after themselves", () => {
    expect(webhookEventsFor({ type: "work_item.created" })).toEqual(["work_item.created"]);
    expect(webhookEventsFor({ type: "work_item.updated" })).toEqual(["work_item.updated"]);
  });

  it("calls a move into Done both a transition and a completion", () => {
    expect(webhookEventsFor({ type: "work_item.transitioned", fromCategory: "IN_PROGRESS", toCategory: "DONE" })).toEqual([
      "work_item.transitioned",
      "work_item.completed",
    ]);
  });

  it("doesn't call a move between two Done statuses, or out of Done, a completion", () => {
    expect(webhookEventsFor({ type: "work_item.transitioned", fromCategory: "DONE", toCategory: "DONE" })).toEqual(["work_item.transitioned"]);
    expect(webhookEventsFor({ type: "work_item.transitioned", fromCategory: "DONE", toCategory: "TODO" })).toEqual(["work_item.transitioned"]);
    expect(webhookEventsFor({ type: "work_item.transitioned", fromCategory: "TODO", toCategory: "CANCELLED" })).toEqual(["work_item.transitioned"]);
  });

  it("sends nothing for an outbox event no webhook name covers", () => {
    expect(webhookEventsFor({ type: "work_item.archived" })).toEqual([]);
  });

  it("offers only names it can send", () => {
    const sendable = new Set(
      [
        webhookEventsFor({ type: "work_item.created" }),
        webhookEventsFor({ type: "work_item.updated" }),
        webhookEventsFor({ type: "work_item.transitioned", fromCategory: "TODO", toCategory: "DONE" }),
      ].flat(),
    );
    expect(WEBHOOK_EVENTS.map((e) => e.name).filter((n) => !sendable.has(n))).toEqual([]);
  });
});
