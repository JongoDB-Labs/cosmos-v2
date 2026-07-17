import { describe, it, expect } from "vitest";
import { workItemNotifyPayload } from "./db.mjs";

describe("workItemNotifyPayload (foreman realtime board emits)", () => {
  it("mirrors the app pg-bus NotifyPayload: work-item.updated type + org: topic", () => {
    const p = JSON.parse(
      workItemNotifyPayload("inst-1", { orgId: "o1", projectId: "p1", columnKey: "review" }, "wi-1"),
    );
    expect(p).toEqual({
      instanceId: "inst-1",
      topic: "org:o1",
      type: "work-item.updated",
      data: { id: "wi-1", projectId: "p1", columnKey: "review" },
    });
  });

  it("carries the item id + destination column so boards can refetch/patch", () => {
    const p = JSON.parse(
      workItemNotifyPayload("x", { orgId: "org", projectId: "proj", columnKey: "in-progress" }, "abc"),
    );
    expect(p.type).toBe("work-item.updated");
    expect(p.data.columnKey).toBe("in-progress");
    expect(p.data.id).toBe("abc");
  });
});
