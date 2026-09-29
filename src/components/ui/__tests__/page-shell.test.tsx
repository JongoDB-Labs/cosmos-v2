// PageShell is where 33 routes get their walkthrough anchor, so the attribute
// actually reaching the DOM is load-bearing: a step naming an anchor nothing
// renders falls back to a corner card and narrates at a page the reader has to
// search themselves. The plugin's tours.arch.test.ts proves the NAME is
// spelled somewhere; this proves the shell still emits it.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PageShell } from "../page-shell";

describe("PageShell walkthrough anchors", () => {
  it("marks the content, not the whole page, so the highlight means something", () => {
    const { container } = render(
      <PageShell title="Bills" tourAnchor="bills">
        <p>owed</p>
      </PageShell>,
    );
    const anchored = container.querySelector('[data-tour="bills"]');
    expect(anchored).not.toBeNull();
    // The title sits OUTSIDE the anchor: a box drawn round the whole page,
    // heading and all, is one the reader learns to ignore.
    expect(anchored!.textContent).toBe("owed");
    expect(anchored!.querySelector("h1")).toBeNull();
  });

  it("adds no wrapper at all when no anchor is asked for", () => {
    const { container } = render(
      <PageShell title="Bills">
        <p>owed</p>
      </PageShell>,
    );
    expect(container.querySelector("[data-tour]")).toBeNull();
  });
});
