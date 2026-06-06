import { describe, expect, it, vi } from "vitest";
import { createMemoryBus } from "./adapter-memory";

describe("memory bus adapter", () => {
  it("delivers a published event to subscribers of that topic", async () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribe(["channel:c1"], handler);
    await bus.publish("channel:c1", "test.event", { foo: 1 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ topic: "channel:c1", type: "test.event", data: { foo: 1 } });
  });

  it("ignores unrelated topics", async () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribe(["channel:c1"], handler);
    await bus.publish("channel:c2", "test.event", {});
    expect(handler).not.toHaveBeenCalled();
  });

  it("fans out to multiple subscribers on the same topic", async () => {
    const bus = createMemoryBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(["user:u1"], a);
    bus.subscribe(["user:u1"], b);
    await bus.publish("user:u1", "ping", {});
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("subscribes a single handler to multiple topics", async () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribe(["channel:c1", "channel:c2"], handler);
    await bus.publish("channel:c1", "a", {});
    await bus.publish("channel:c2", "b", {});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes cleanly", async () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    const unsub = bus.subscribe(["channel:c1"], handler);
    unsub();
    await bus.publish("channel:c1", "test", {});
    expect(handler).not.toHaveBeenCalled();
  });

  it("isolates one subscriber's failure from others", async () => {
    const bus = createMemoryBus();
    const ok = vi.fn();
    const bad = vi.fn(() => { throw new Error("boom"); });
    bus.subscribe(["x:y"], bad);
    bus.subscribe(["x:y"], ok);
    await bus.publish("x:y", "evt", {});
    expect(ok).toHaveBeenCalledOnce();
  });

  it("close() drops all subscribers", async () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribe(["channel:c1"], handler);
    await bus.close();
    await bus.publish("channel:c1", "test", {});
    expect(handler).not.toHaveBeenCalled();
  });
});
