// @vitest-environment jsdom
//
// What's new keeps every walkthrough reachable. The footer button offers the
// newest UNSEEN tour once; after that, the list under the notes is the way back
// to it from the modal, seen or not, always from the first step. A deployment
// with no tours shows neither.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Tour } from "@/lib/tours/types";

const { start, plugins } = vi.hoisted(() => ({
  start: vi.fn(),
  plugins: { list: [] as { slug: string; tours?: Tour[] }[] },
}));
vi.mock("@/components/tour/tour-provider", () => ({ useTour: () => ({ start }) }));
vi.mock("@/components/plugins/plugin-slot", () => ({ useEnabledPlugins: () => new Set(["demo"]) }));
vi.mock("@/components/providers/permissions-provider", () => ({ usePermissions: () => ({ permissions: 0n }) }));
vi.mock("@/lib/plugins/registry", () => ({ PluginRegistry: { getAll: () => plugins.list } }));

import { WhatsNew } from "./whats-new-modal";

const tour = (id: string, released: string): Tour => ({
  id, name: `Tour ${id}`, summary: `About ${id}`, released,
  steps: [{ id: "s1", title: "Step one", blurb: "b", look: "l" }],
});
const OLD = tour("old", "2026-09-01");
const NEW = tour("new", "2026-10-01");

const openModal = () => {
  render(<WhatsNew />);
  act(() => { window.dispatchEvent(new Event("cosmos:open-whats-new")); });
};

beforeEach(() => {
  start.mockClear();
  localStorage.clear();
  plugins.list = [{ slug: "demo", tours: [OLD, NEW] }];
});

describe("What's new: walkthroughs", () => {
  it("lists every walkthrough on offer, including ones already seen", async () => {
    localStorage.setItem("cosmos:tours-seen", JSON.stringify(["old", "new"]));
    openModal();
    expect(await screen.findByText("Walkthroughs")).toBeTruthy();
    expect(screen.getByText("Tour new")).toBeTruthy();
    expect(screen.getByText("Tour old")).toBeTruthy();
    // Both seen: the one-time offer is spent, the list is not.
    expect(screen.queryByRole("button", { name: /Walk me through it/ })).toBeNull();
  });

  it("starts a picked walkthrough from the first step and closes the notes", async () => {
    localStorage.setItem("cosmos:tours-seen", JSON.stringify(["old", "new"]));
    openModal();
    fireEvent.click(await screen.findByText("Tour old"));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: "old" }), 0);
    expect(screen.queryByRole("region", { name: "Release notes" })).toBeNull();
  });

  it("still offers the newest unseen one in the footer", async () => {
    localStorage.setItem("cosmos:tours-seen", JSON.stringify(["old"]));
    openModal();
    fireEvent.click(await screen.findByRole("button", { name: /Walk me through it/ }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }), 0);
  });

  it("shows no walkthrough section at all on a deployment without tours", async () => {
    plugins.list = [{ slug: "demo" }];
    openModal();
    expect(await screen.findByRole("region", { name: "Release notes" })).toBeTruthy();
    expect(screen.queryByText("Walkthroughs")).toBeNull();
    expect(screen.queryByRole("button", { name: /Walk me through it/ })).toBeNull();
  });
});
