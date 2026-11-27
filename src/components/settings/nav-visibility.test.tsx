// @vitest-environment jsdom
//
// The sidebar-visibility panel confirmed a save behind `saved && !dirty`, and
// nothing ever cleared `dirty` after a save: `hidden` keeps the user's choice
// and `initialHidden` is the prop it was compared against, so the save landed
// and the screen said nothing at all.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import { NavVisibility } from "./nav-visibility";

const SECTIONS = [
  { id: "documents", label: "Documents" },
  { id: "reports", label: "Reports" },
];
const CONFIRMATION = "Saved — reload to see the sidebar change.";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("NavVisibility", () => {
  it("confirms a save that succeeded", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    render(<NavVisibility orgId="o1" sections={SECTIONS} initialHidden={[]} />);

    fireEvent.click(screen.getByRole("switch", { name: "Show Documents in the sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(CONFIRMATION)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/orgs/o1/nav-layout",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ hidden: ["documents"] }) }),
    );
  });

  it("says nothing before a save, and nothing when one fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Could not save" }), { status: 500 }),
    );
    render(<NavVisibility orgId="o1" sections={SECTIONS} initialHidden={[]} />);

    fireEvent.click(screen.getByRole("switch", { name: "Show Reports in the sidebar" }));
    expect(screen.queryByText(CONFIRMATION)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Could not save")).toBeTruthy());
    expect(screen.queryByText(CONFIRMATION)).toBeNull();
  });

  it("drops the confirmation once the choice changes again", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    render(<NavVisibility orgId="o1" sections={SECTIONS} initialHidden={[]} />);

    fireEvent.click(screen.getByRole("switch", { name: "Show Documents in the sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(CONFIRMATION);

    fireEvent.click(screen.getByRole("switch", { name: "Show Reports in the sidebar" }));
    expect(screen.queryByText(CONFIRMATION)).toBeNull();
  });
});
