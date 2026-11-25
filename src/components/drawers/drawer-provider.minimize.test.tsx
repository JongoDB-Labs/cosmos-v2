// @vitest-environment jsdom
//
// Minimize puts the drawer aside to a side tab without forgetting which tool
// was selected, and only "minimized + which tool" survives a reload. An open
// drawer still starts closed after a reload, and something that opens a drawer
// on load (a chat link) wins over the remembered tab.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import { DrawerProvider, useDrawers, MINIMIZED_KEY, type DrawerTool } from "./drawer-provider";

let api: ReturnType<typeof useDrawers>;
function Probe() {
  const d = useDrawers();
  useEffect(() => {
    api = d;
  });
  const shown = d;
  return (
    <span data-testid="state">
      {String(shown.tool)}/{shown.minimized ? "min" : "-"}/{shown.isShown ? "shown" : "-"}
    </span>
  );
}
const state = () => screen.getByTestId("state").textContent;

/** Opens a drawer in a child effect — the same commit as the provider's restore. */
function OpenOnMount({ tool }: { tool: DrawerTool }) {
  const { open } = useDrawers();
  useEffect(() => open(tool), [open, tool]);
  return null;
}

let store: Map<string, string>;
const real = window.localStorage;
function fakeStorage(opts: { throws?: boolean } = {}) {
  store = new Map();
  const guard = () => {
    if (opts.throws) throw new Error("denied");
  };
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (k: string) => (guard(), store.get(k) ?? null),
      setItem: (k: string, v: string) => (guard(), void store.set(k, v)),
      removeItem: (k: string) => (guard(), void store.delete(k)),
      clear: () => store.clear(),
    },
    configurable: true,
  });
}

beforeEach(() => fakeStorage());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(window, "localStorage", { value: real, configurable: true });
});

function mount(extra?: React.ReactNode) {
  return render(
    <DrawerProvider>
      {extra}
      <Probe />
    </DrawerProvider>,
  );
}

describe("DrawerProvider — minimize", () => {
  it("minimize and restore keep the selected tool", () => {
    mount();
    act(() => api.open("notes"));
    expect(state()).toBe("notes/-/shown");
    act(() => api.minimize());
    expect(state()).toBe("notes/min/-");
    expect(api.isOpen("notes")).toBe(true);
    act(() => api.restore());
    expect(state()).toBe("notes/-/shown");
  });

  it("close clears minimized", () => {
    mount();
    act(() => api.open("chat"));
    act(() => api.minimize());
    act(() => api.close());
    expect(state()).toBe("null/-/-");
  });

  it("opening another tool while minimized switches and un-minimizes", () => {
    mount();
    act(() => api.open("assistant"));
    act(() => api.minimize());
    act(() => api.open("notes"));
    expect(state()).toBe("notes/-/shown");
  });

  it("toggle on the minimized tool restores it instead of closing", () => {
    mount();
    act(() => api.open("meetings"));
    act(() => api.minimize());
    act(() => api.toggle("meetings"));
    expect(state()).toBe("meetings/-/shown");
    act(() => api.toggle("meetings"));
    expect(state()).toBe("null/-/-");
  });

  it("minimize from closed lands on the assistant", () => {
    mount();
    act(() => api.minimize());
    expect(state()).toBe("assistant/min/-");
    act(() => api.restore());
    expect(state()).toBe("assistant/-/shown");
  });

  it("remembers only the minimized tool, and forgets it on restore, switch and close", () => {
    mount();
    act(() => api.open("feedback"));
    expect(store.has(MINIMIZED_KEY)).toBe(false); // an open drawer is not remembered
    act(() => api.minimize());
    expect(JSON.parse(store.get(MINIMIZED_KEY)!)).toEqual({ tool: "feedback" });
    act(() => api.restore());
    expect(store.has(MINIMIZED_KEY)).toBe(false);
    act(() => api.minimize());
    act(() => api.open("notes"));
    expect(store.has(MINIMIZED_KEY)).toBe(false);
    act(() => api.minimize());
    act(() => api.close());
    expect(store.has(MINIMIZED_KEY)).toBe(false);
  });

  it("restores a remembered tab after mount", () => {
    store.set(MINIMIZED_KEY, JSON.stringify({ tool: "chat" }));
    mount();
    expect(state()).toBe("chat/min/-");
    expect(store.get(MINIMIZED_KEY)).toBe(JSON.stringify({ tool: "chat" }));
  });

  it("ignores and removes an invalid remembered tool", () => {
    store.set(MINIMIZED_KEY, JSON.stringify({ tool: "nope" }));
    mount();
    expect(state()).toBe("null/-/-");
    expect(store.has(MINIMIZED_KEY)).toBe(false);
    store.set(MINIMIZED_KEY, "{not json");
    cleanup();
    mount();
    expect(state()).toBe("null/-/-");
  });

  it("a drawer opened on load wins over the remembered tab", () => {
    store.set(MINIMIZED_KEY, JSON.stringify({ tool: "notes" }));
    mount(<OpenOnMount tool="chat" />);
    expect(state()).toBe("chat/-/shown");
  });

  it("a throwing localStorage never throws out of the provider", () => {
    fakeStorage({ throws: true });
    mount();
    act(() => api.open("assistant"));
    act(() => api.minimize());
    act(() => api.close());
    expect(state()).toBe("null/-/-");
  });
});
