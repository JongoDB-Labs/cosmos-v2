import { describe, it, expect } from "vitest";
import { describeEventBacklog, STALLED_AFTER_SECONDS } from "./backlog.server";

const b = (over: Partial<Parameters<typeof describeEventBacklog>[0] & object> = {}) => ({
  unprocessed: 0,
  oldestAgeSeconds: null,
  pendingDeliveries: 0,
  failedDeliveriesLastHour: 0,
  ...over,
});

describe("describeEventBacklog", () => {
  it("is fine with nothing waiting, or a little in flight", () => {
    expect(describeEventBacklog(b())).toMatchObject({ tone: "ok", headline: "Change events are processed as they happen." });
    expect(describeEventBacklog(b({ unprocessed: 3, oldestAgeSeconds: 2 }))).toMatchObject({ tone: "ok", headline: expect.stringContaining("3 in flight") });
  });

  it("says the worker looks stopped once the oldest event has waited too long", () => {
    const h = describeEventBacklog(b({ unprocessed: 12, oldestAgeSeconds: STALLED_AFTER_SECONDS }));
    expect(h.tone).toBe("error");
    expect(h.headline).toBe("12 change events are waiting; the oldest for 5 min.");
    expect(h.detail).toMatch(/looks stopped/);
    expect(describeEventBacklog(b({ unprocessed: 1, oldestAgeSeconds: STALLED_AFTER_SECONDS - 1 })).tone).toBe("ok");
  });

  it("warns about webhook deliveries that gave up, and mentions queued ones", () => {
    expect(describeEventBacklog(b({ failedDeliveriesLastHour: 2 }))).toMatchObject({ tone: "warn", detail: "2 webhook deliveries gave up in the last hour." });
    expect(describeEventBacklog(b({ pendingDeliveries: 1 }))).toMatchObject({ tone: "ok", detail: "1 webhook delivery queued or waiting to retry." });
  });

  it("says it couldn't read the backlog rather than guessing", () => {
    expect(describeEventBacklog(null)).toMatchObject({ tone: "muted", backlog: null });
  });
});
