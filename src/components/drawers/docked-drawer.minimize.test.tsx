// @vitest-environment jsdom
//
// Minimize puts the drawer aside without throwing away the assistant: its
// panel stays mounted (conversation, draft and a streaming reply survive),
// hidden and inert. Other tools unmount, so a hidden Chat cannot keep marking
// messages read. Escape minimizes — only for keys pressed inside the drawer,
// never a key some list inside it already handled, and never also reaching a
// page's own window-level Escape.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

let desktop = true;
vi.mock("@/lib/hooks/use-media-query", () => ({ useMediaQuery: () => desktop }));
vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true }),
}));

const mounts = { assistant: 0, chat: 0 };
const live = { assistant: 0, chat: 0 };
function stub(name: "assistant" | "chat", withComposer: boolean) {
  return function Stub() {
    const [draft, setDraft] = useState("");
    useEffect(() => {
      mounts[name]++;
      live[name]++;
      return () => {
        live[name]--;
      };
    }, []);
    return withComposer ? (
      <textarea aria-label="composer" value={draft} onChange={(e) => setDraft(e.target.value)} />
    ) : (
      <div>{name} body</div>
    );
  };
}
let composerDisabled = false;
vi.mock("@/components/assistant/assistant-panel", () => {
  const Inner = stub("assistant", true);
  return {
    AssistantPanel: function AssistantStub() {
      return composerDisabled ? <textarea aria-label="composer" disabled /> : <Inner />;
    },
  };
});
vi.mock("./panels/chat-panel", () => ({ ChatPanel: stub("chat", false) }));
vi.mock("./panels/notes-panel", () => ({ NotesPanel: () => null }));
vi.mock("./panels/feedback-panel", () => ({ FeedbackPanel: () => null }));
vi.mock("./panels/meetings-panel", () => ({ MeetingsPanel: () => null }));

import { DrawerProvider, useDrawers, MINIMIZED_KEY } from "./drawer-provider";
import { DockedDrawer } from "./docked-drawer";
import { FloatingAgentBubble } from "@/components/layouts/floating-agent-bubble";

let api: ReturnType<typeof useDrawers>;
function Grab() {
  const d = useDrawers();
  useEffect(() => {
    api = d;
  });
  return null;
}

function mount() {
  return render(
    <DrawerProvider>
      <Grab />
      <button>page button</button>
      <FloatingAgentBubble orgId="org-1" />
      <DockedDrawer orgId="org-1" orgSlug="acme" userId="u1" />
    </DrawerProvider>,
  );
}

const aside = () => document.getElementById("cosmos-drawer");
const tab = () => screen.getByRole("button", { name: /^Restore / });
/** requestAnimationFrame callbacks (focus moves) run on the next frame. */
const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

beforeEach(() => {
  desktop = true;
  composerDisabled = false;
  mounts.assistant = mounts.chat = 0;
  live.assistant = live.chat = 0;
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("DockedDrawer — minimize", () => {
  it("keeps the assistant mounted with its draft, hidden and inert", async () => {
    mount();
    act(() => api.open("assistant"));
    fireEvent.change(screen.getByLabelText("composer"), { target: { value: "half a question" } });

    fireEvent.click(screen.getByRole("button", { name: "Minimize drawer" }));
    await frame();
    expect(aside()).not.toBeNull();
    expect(aside()!.hidden).toBe(true);
    expect(aside()!.hasAttribute("inert")).toBe(true);
    expect(live.assistant).toBe(1);
    expect(document.activeElement).toBe(tab());
    expect(tab().getAttribute("aria-expanded")).toBe("false");
    expect(tab().getAttribute("aria-controls")).toBe("cosmos-drawer");

    fireEvent.click(tab());
    await frame();
    expect(mounts.assistant).toBe(1);
    const composer = screen.getByLabelText("composer") as HTMLTextAreaElement;
    expect(composer.value).toBe("half a question");
    expect(document.activeElement).toBe(composer);
    const min = screen.getByRole("button", { name: "Minimize drawer" });
    expect(min.getAttribute("aria-expanded")).toBe("true");
    expect(min.getAttribute("aria-controls")).toBe("cosmos-drawer");
  });

  it("unmounts other tools while minimized", () => {
    mount();
    act(() => api.open("chat"));
    expect(live.chat).toBe(1);
    act(() => api.minimize());
    expect(live.chat).toBe(0);
    act(() => api.restore());
    expect(live.chat).toBe(1);
  });

  it("restores focus to the Minimize button when the composer is disabled", async () => {
    composerDisabled = true;
    mount();
    act(() => api.open("assistant"));
    act(() => api.minimize());
    fireEvent.click(tab());
    await frame();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Minimize drawer" }));
  });

  it("restores focus to the Minimize button on phones", async () => {
    desktop = false;
    mount();
    act(() => api.open("assistant"));
    act(() => api.minimize());
    fireEvent.click(tab());
    await frame();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Minimize drawer" }));
  });

  it("mounts nothing after a reload into the minimized state until restored", () => {
    window.localStorage.setItem(MINIMIZED_KEY, JSON.stringify({ tool: "assistant" }));
    mount();
    expect(tab()).toBeTruthy();
    expect(aside()!.hidden).toBe(true);
    expect(mounts.assistant).toBe(0);
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
    fireEvent.click(tab());
    expect(mounts.assistant).toBe(1);
  });

  it("the corner button's minimize control goes straight to the tab without mounting", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /to the side$/ }));
    await frame();
    expect(document.activeElement).toBe(tab());
    expect(mounts.assistant).toBe(0);
    expect(aside()).not.toBeNull(); // aria-controls resolves
  });

  it("forgets 'has been shown' on close, so a later corner minimize mounts nothing", () => {
    mount();
    act(() => api.open("assistant"));
    act(() => api.close());
    act(() => api.minimize());
    expect(live.assistant).toBe(0);
  });

  it("publishes the tab's width while minimized on desktop, 0 on phones", () => {
    const w = () => document.documentElement.style.getPropertyValue("--cosmos-drawer-w");
    mount();
    act(() => api.open("notes"));
    expect(w()).toBe("460px");
    act(() => api.minimize());
    expect(w()).toBe("40px");
    cleanup();
    desktop = false;
    mount();
    act(() => api.minimize());
    expect(w()).toBe("0px");
  });
});

describe("DockedDrawer — Escape", () => {
  function setup() {
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    mount();
    act(() => api.open("assistant"));
    return {
      onWindow,
      done: () => window.removeEventListener("keydown", onWindow),
    };
  }

  it("minimizes (does not close) and never reaches a window listener", () => {
    const { onWindow, done } = setup();
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "Escape" });
    expect(api.tool).toBe("assistant");
    expect(api.minimized).toBe(true);
    expect(onWindow).not.toHaveBeenCalled();
    done();
  });

  it("does nothing for an Escape outside the drawer", () => {
    const { done } = setup();
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(screen.getByText("page button"), { key: "Escape" });
    expect(api.minimized).toBe(false);
    done();
  });

  it("leaves an already-handled Escape alone, and still keeps it from the page", () => {
    const { onWindow, done } = setup();
    const composer = screen.getByLabelText("composer");
    // A capture-phase handler (an open @-list) handles the key first.
    const capture = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", capture, true);
    fireEvent.keyDown(composer, { key: "Escape" });
    window.removeEventListener("keydown", capture, true);
    expect(api.minimized).toBe(false);
    expect(onWindow).not.toHaveBeenCalled();
    done();
  });

  it("ignores Escape during IME composition", () => {
    const { done } = setup();
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "Escape", isComposing: true });
    expect(api.minimized).toBe(false);
    done();
  });
});
