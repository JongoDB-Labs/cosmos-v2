// @vitest-environment jsdom
//
// The org SSE stream has NO replay: the server emits no `id:` field, so the
// browser's `Last-Event-ID` reconnect header has nothing to ask for, and the
// route ignores it regardless. Anything published while a client is
// disconnected is gone for good.
//
// `EventSource` reconnects by itself, so the connection always comes back and
// everything LOOKS healthy — but the events from the gap never arrive, and
// before `onResync` existed nothing told the app it had missed any. A view just
// kept showing stale rows, which is indistinguishable from "nothing changed".
//
// The costly case is a deploy: the app restarts, every open tab's stream drops
// at once, and every one of them silently stopped updating until a human
// pressed refresh. These tests pin the recovery.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  listeners = new Map<string, EventListener[]>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: EventListener) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  removeEventListener(type: string, fn: EventListener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  close() {
    this.closed = true;
  }
  /** Simulate the server pushing a named event. */
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
  /** Simulate the transport connecting (fires on first connect AND reconnects). */
  connect() {
    this.onopen?.();
  }
}

/** A BroadcastChannel stand-in that records posts and can deliver them. */
function makeChannel() {
  const listeners: Array<(ev: MessageEvent) => void> = [];
  return {
    posted: [] as unknown[],
    postMessage(msg: unknown) {
      this.posted.push(msg);
    },
    addEventListener(_t: string, fn: (ev: MessageEvent) => void) {
      listeners.push(fn);
    },
    removeEventListener(_t: string, fn: (ev: MessageEvent) => void) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    deliver(msg: unknown) {
      for (const fn of [...listeners]) fn({ data: msg } as MessageEvent);
    },
  };
}

let channel = makeChannel();
let leader = true;

vi.mock("./use-broadcast-channel-leader", () => ({
  useBroadcastChannelLeader: () => ({ isLeader: leader, bcRef: { current: channel } }),
}));

import { useRealtimeEvents } from "./use-realtime-events";

beforeEach(() => {
  FakeEventSource.instances = [];
  channel = makeChannel();
  leader = true;
  vi.stubGlobal("EventSource", FakeEventSource);
});

const render = (handlers = {}, onResync?: () => void) =>
  renderHook(() => useRealtimeEvents("org-1", handlers, onResync ? { onResync } : undefined));

describe("the leader tab", () => {
  it("does NOT resync on the first connect", () => {
    // The view's own query already fetched current state on mount. Firing here
    // would add a duplicate request to every page load and buy nothing.
    const onResync = vi.fn();
    render({}, onResync);
    FakeEventSource.instances[0].connect();
    expect(onResync).not.toHaveBeenCalled();
  });

  it("resyncs when the stream RE-connects", () => {
    const onResync = vi.fn();
    render({}, onResync);
    const es = FakeEventSource.instances[0];
    es.connect(); // initial
    es.connect(); // EventSource reconnected after a drop
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("resyncs again on every subsequent reconnect", () => {
    // A flapping connection must not resync only once and then give up.
    const onResync = vi.fn();
    render({}, onResync);
    const es = FakeEventSource.instances[0];
    es.connect();
    es.connect();
    es.connect();
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it("tells the follower tabs they are stale too", () => {
    render({}, vi.fn());
    const es = FakeEventSource.instances[0];
    es.connect();
    es.connect();
    const resyncPosts = channel.posted.filter(
      (m) => (m as { type?: string }).type === "__cosmos.resync",
    );
    expect(resyncPosts).toHaveLength(1);
  });

  it("posts nothing on the first connect", () => {
    render({}, vi.fn());
    FakeEventSource.instances[0].connect();
    expect(channel.posted).toHaveLength(0);
  });

  it("still dispatches ordinary events — the negative control", () => {
    // If this broke, every test above could pass against a hook that had
    // stopped delivering events entirely.
    const onChange = vi.fn();
    render({ "work-item.updated": onChange });
    FakeEventSource.instances[0].emit("work-item.updated", { projectId: "p1" });
    expect(onChange).toHaveBeenCalledWith({ projectId: "p1" });
  });

  it("works when no onResync is supplied", () => {
    // Most callers do not pass one; a reconnect must not throw for them.
    render({});
    const es = FakeEventSource.instances[0];
    es.connect();
    expect(() => es.connect()).not.toThrow();
  });
});

describe("a follower tab", () => {
  beforeEach(() => {
    leader = false;
  });

  it("opens no EventSource of its own", () => {
    render({}, vi.fn());
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("resyncs when the leader says the stream reconnected", () => {
    // A follower reads that one stream through the leader, so it missed exactly
    // the same events the leader did.
    const onResync = vi.fn();
    render({}, onResync);
    channel.deliver({ type: "__cosmos.resync", data: "{}" });
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("does not mistake the resync marker for a real event", () => {
    const handler = vi.fn();
    render({ "__cosmos.resync": handler }, vi.fn());
    channel.deliver({ type: "__cosmos.resync", data: "{}" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("still receives rebroadcast events — the negative control", () => {
    const onChange = vi.fn();
    render({ "work-item.created": onChange }, vi.fn());
    channel.deliver({ type: "work-item.created", data: JSON.stringify({ projectId: "p2" }) });
    expect(onChange).toHaveBeenCalledWith({ projectId: "p2" });
  });
});
