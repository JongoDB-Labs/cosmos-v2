// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabList, type TabDef } from "./console-tabs";

const TABS: TabDef[] = [
  { id: "activity", label: "Activity" },
  { id: "connections", label: "Connections" },
];

describe("TabList", () => {
  it("renders a tablist with a tab per def and marks the active one selected", () => {
    render(<TabList tabs={TABS} active="activity" onSelect={() => {}} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Connections" })).toHaveAttribute("aria-selected", "false");
  });
  it("calls onSelect with the tab id when a tab is clicked", () => {
    const onSelect = vi.fn();
    render(<TabList tabs={TABS} active="activity" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(onSelect).toHaveBeenCalledWith("connections");
  });
  it("moves selection with Right/Left arrow keys", () => {
    const onSelect = vi.fn();
    render(<TabList tabs={TABS} active="activity" onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("connections");
  });
});
