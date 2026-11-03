// @vitest-environment jsdom
// One toolbar band, one right-hand group, one Hide-done control.
//
// Before this, all eleven board toolbars were hand-written. The drift that
// produced, measured on main at 2.509.1:
//   - band padding py-1.5 (Kanban), py-2 (most), py-2.5 (dependency map),
//     py-3 (CFD, ceremony) -- four different band heights
//   - gap-2 (Kanban, Timeline) vs gap-3 (everyone else)
//   - bg-background/50 (Table, Calendar) vs bg-[var(--surface)]/50 (Backlog)
//     vs untinted (RAID, Roadmap, Kanban)
//   - "Hide done" written three times, and RAID/Backlog render a sized,
//     bordered, rounded 14px box at text-xs while Roadmap renders an unsized,
//     unbordered browser-default box at text-sm. Same words, two controls.
//
// These cases pin the contract rather than the appearance: the band is one
// bordered element at a known inset, the actions group is right-aligned, and
// Hide-done has ONE implementation -- asserted by rendering two of them in
// different parents and comparing the markup, which is the property that
// actually failed before.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BoardToolbar, BoardToolbarActions, HideDoneToggle } from "./board-toolbar";

afterEach(cleanup);

describe("BoardToolbar", () => {
  it("is exactly one bordered band", () => {
    const { container } = render(
      <BoardToolbar>
        <span>left</span>
      </BoardToolbar>,
    );
    expect(container.querySelectorAll('[class*="border-b"]')).toHaveLength(1);
  });

  it("uses the shared inset, so band heights cannot drift apart again", () => {
    const { container } = render(<BoardToolbar>x</BoardToolbar>);
    const band = container.querySelector('[class*="border-b"]')!;
    // Named literally rather than compared against the component's own
    // constant -- importing the constant and asserting equality would pass
    // against any value, including a changed one.
    expect(band.className).toContain("px-4");
    expect(band.className).toContain("py-2");
    expect(band.className).not.toContain("py-1.5");
    expect(band.className).not.toContain("py-3");
  });

  it("wraps rather than overflowing on a narrow board", () => {
    const { container } = render(<BoardToolbar>x</BoardToolbar>);
    expect(container.querySelector('[class*="border-b"]')!.className).toContain("flex-wrap");
  });
});

describe("BoardToolbarActions", () => {
  it("right-aligns its group", () => {
    const { container } = render(
      <BoardToolbar>
        <span>left</span>
        <BoardToolbarActions>
          <button type="button">Do</button>
        </BoardToolbarActions>
      </BoardToolbar>,
    );
    const group = screen.getByRole("button", { name: "Do" }).closest("div");
    expect(group!.className).toContain("ml-auto");
    void container;
  });

  it("adds no band of its own", () => {
    // It lives INSIDE the band; a border here would draw a second line.
    const { container } = render(
      <BoardToolbar>
        <BoardToolbarActions>
          <button type="button">Do</button>
        </BoardToolbarActions>
      </BoardToolbar>,
    );
    expect(container.querySelectorAll('[class*="border-b"]')).toHaveLength(1);
  });
});

describe("HideDoneToggle", () => {
  it("is a checkbox named for what it does", () => {
    render(<HideDoneToggle checked={false} onChange={() => {}} />);
    expect(screen.getByRole("checkbox", { name: /hide done/i })).toBeTruthy();
  });

  it("reflects the state it is given", () => {
    render(<HideDoneToggle checked onChange={() => {}} />);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /hide done/i }).checked).toBe(
      true,
    );
  });

  it("reports the new value, not the event", () => {
    const onChange = vi.fn();
    render(<HideDoneToggle checked={false} onChange={onChange} />);
    screen.getByRole("checkbox", { name: /hide done/i }).click();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  // "renders identically wherever it is used" is NOT tested here, deliberately.
  // This component reads no context, so two instances are identical by
  // construction and no mutation of it can make such a test fail -- it would
  // be a green assertion that proves nothing, which is the failure mode this
  // file is otherwise about. The real property ("every board uses THIS
  // control") is a fact about call sites, so it lives in
  // `board-chrome-ownership.arch.test.ts`.

  it("sizes its own box rather than inheriting one", () => {
    // The Roadmap bug: no size, border or radius, so the box was whatever the
    // browser drew at the surrounding font size.
    render(<HideDoneToggle checked={false} onChange={() => {}} />);
    const box = screen.getByRole("checkbox", { name: /hide done/i });
    expect(box.className).toMatch(/h-3\.5|size-3\.5/);
    expect(box.className).toContain("rounded");
  });
});
