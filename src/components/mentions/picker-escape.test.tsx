// @vitest-environment jsdom
//
// One Escape, one action. The @-mention and slash-command lists close on
// Escape and mark the key handled, in the CAPTURE phase, so the docked drawer
// around them (which minimizes on Escape) can tell "Escape closed a list" from
// "Escape meant the panel". They used to close from a bubble-phase window
// listener without marking anything, so one key both closed the list and
// put the panel away.
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

vi.mock("./hooks", () => ({
  useEntitySearch: (_org: string, q: string) => ({
    data: q ? [{ type: "project", id: "p1", label: "Falcon Program", key: "FAL" }] : [],
    isFetching: false,
  }),
}));
vi.mock("@/lib/hooks/use-media-query", () => ({ useMediaQuery: () => true }));
vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true }),
}));

import { EntityMentionPicker } from "./entity-mention-picker";
import { MentionPicker } from "@/components/chat/mention-picker";
import { SlashCommandMenu } from "@/components/chat/slash-command-menu";

const anchor = { top: 0, left: 0 };
// jsdom has no layout; the list scrolls its active row into view.
Element.prototype.scrollIntoView = function () {};
afterEach(() => cleanup());

function pressEscape(target: Element = document.body) {
  const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

describe("picker Escape", () => {
  it("entity @-list: cancels and marks the key handled", () => {
    const onCancel = vi.fn();
    render(<EntityMentionPicker orgId="o" query="Fal" anchor={anchor} onPick={vi.fn()} onCancel={onCancel} />);
    const ev = pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("entity @-list: a bare @ (nothing shown) leaves Escape alone", () => {
    const onCancel = vi.fn();
    render(<EntityMentionPicker orgId="o" query="" anchor={anchor} onPick={vi.fn()} onCancel={onCancel} />);
    const ev = pressEscape();
    expect(onCancel).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("chat member list: cancels and marks the key handled", () => {
    const onCancel = vi.fn();
    render(
      <MentionPicker
        query="al"
        anchor={anchor}
        members={[{ id: "u1", displayName: "Alice", email: "alice@x", avatarUrl: null }]}
        onPick={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const ev = pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("slash-command menu: cancels and marks the key handled", () => {
    const onCancel = vi.fn();
    render(<SlashCommandMenu prefix="" canManage anchor={anchor} onPick={vi.fn()} onCancel={onCancel} />);
    const ev = pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("picker Escape inside the docked drawer", () => {
  it("closes the list and leaves the drawer expanded", async () => {
    vi.resetModules();
    vi.doMock("@/components/assistant/assistant-panel", () => ({
      AssistantPanel: function Composer() {
        const [open, setOpen] = useState(true);
        return (
          <div>
            <textarea aria-label="composer" />
            {open && (
              <EntityMentionPicker orgId="o" query="Fal" anchor={anchor} onPick={vi.fn()} onCancel={() => setOpen(false)} />
            )}
          </div>
        );
      },
    }));
    const { DrawerProvider, useDrawers } = await import("@/components/drawers/drawer-provider");
    const { DockedDrawer } = await import("@/components/drawers/docked-drawer");
    let api!: ReturnType<typeof useDrawers>;
    function Grab() {
      api = useDrawers();
      return null;
    }
    render(
      <DrawerProvider>
        <Grab />
        <DockedDrawer orgId="o" orgSlug="acme" userId="u" />
      </DrawerProvider>,
    );
    act(() => api.open("assistant"));
    expect(screen.getByText("Falcon Program")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "Escape" });
    expect(screen.queryByText("Falcon Program")).toBeNull();
    expect(api.minimized).toBe(false);
    // The next Escape, with no list open, is the panel's.
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "Escape" });
    expect(api.minimized).toBe(true);
  });
});
