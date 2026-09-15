// @vitest-environment jsdom
//
// A Sprint Health panel must keep its content inside its own card.
//
// WHY THIS ASSERTS CLASSES RATHER THAN PIXELS. On the Current-sprint grid every
// widget lives in a react-grid-layout cell whose height is a fixed pixel value
// computed from `h` in DEFAULT_LAYOUTS — 7 rows is ~282px whatever the panel
// puts inside it. jsdom performs no layout, so no test here can measure that a
// list is taller than its cell; what it CAN check is the one thing that decides
// the outcome, which is whether the region holding the list is allowed to
// overflow. Without a scroll/clip container the list paints straight past the
// card border and over its neighbour — reported from production against
// "Blocked Work" and "Work Type Mix", the two list panels on that grid.
//
// `flex-1 min-h-0` is NOT sufficient on its own: it lets the box shrink, and an
// overflowing child of a shrunk box is exactly what bleeds.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ImpedimentsPanel, WorkTypeMixPanel } from "./delivery-panels";
import type { DeliveryItemLike } from "@/lib/dashboard/delivery-metrics";
import type { WorkItemLinkLike } from "@/lib/dashboard/impediments";

const CLIPS = /\boverflow-(y-)?(auto|scroll|hidden)\b/;

/** The nearest ancestor of `el` that is allowed to clip or scroll its content. */
function containingScrollRegion(el: HTMLElement, root: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node && root.contains(node)) {
    if (CLIPS.test(node.className)) return node;
    node = node.parentElement;
  }
  return null;
}

function item(over: Partial<DeliveryItemLike> = {}): DeliveryItemLike {
  return {
    id: Math.random().toString(36).slice(2),
    intervalId: "s1",
    storyPoints: null,
    actualStart: null,
    completedAt: null,
    done: false,
    typeKey: "story",
    typeName: "Story",
    typeColor: "#3b82f6",
    workCategory: "BUSINESS",
    ...over,
  };
}

/** More rows than a 6-column × 7-row grid cell can show. */
const TYPES = ["story", "bug", "task", "spike", "epic", "chore", "debt", "risk"];

describe("blocked work stays inside its card", () => {
  const items = TYPES.map((t, n) => item({ id: `wi-${n}`, typeKey: t, typeName: t }));
  const links: WorkItemLinkLike[] = items.slice(1).map((it, n) => ({
    id: `l-${n}`,
    type: "BLOCKS",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    sourceItemId: items[0].id,
    sourceTicketNumber: 1,
    sourceTitle: "A blocker with a title long enough to wrap in a narrow grid cell",
    targetItemId: it.id,
    targetTicketNumber: 100 + n,
    targetTitle: "A blocked item with a title long enough to wrap in a narrow grid cell",
  }));

  it("puts the blocked list in a region that scrolls instead of overflowing", () => {
    const { container } = render(
      <ImpedimentsPanel
        items={items}
        links={links}
        now={new Date("2026-09-02T00:00:00Z")}
        bare
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    const list = root.querySelector("ul");
    expect(list, "the panel rendered no blocked rows — the fixture is wrong").not.toBeNull();

    const region = containingScrollRegion(list as HTMLElement, root);
    expect(
      region,
      "nothing between the blocked list and the panel root clips or scrolls, so a " +
        "list taller than the grid cell paints over the neighbouring widget",
    ).not.toBeNull();
    // And it must be free to shrink inside the fixed-height cell, or the region
    // simply grows to fit the list and the scrollbar never appears.
    expect(region!.className).toMatch(/\bmin-h-0\b/);
  });
});

describe("work type mix stays inside its card", () => {
  it("puts the type bars in a region that scrolls instead of overflowing", () => {
    const { container } = render(
      <WorkTypeMixPanel
        items={TYPES.map((t) => item({ typeKey: t, typeName: t }))}
        bare
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    const list = root.querySelector("ul");
    expect(list, "the panel rendered no type rows — the fixture is wrong").not.toBeNull();
    expect(list!.querySelectorAll("li").length).toBe(TYPES.length);

    const region = containingScrollRegion(list as HTMLElement, root);
    expect(
      region,
      "nothing between the work-type list and the panel root clips or scrolls, so a " +
        "list taller than the grid cell paints over the neighbouring widget",
    ).not.toBeNull();
    expect(region!.className).toMatch(/\bmin-h-0\b/);
  });

  it("keeps the footnote below the scrolling region, not inside it", () => {
    // The footnote states what the bars are counted from. If it scrolled with
    // them it would be the first thing pushed out of sight in a short cell.
    const { container } = render(
      <WorkTypeMixPanel items={TYPES.map((t) => item({ typeKey: t, typeName: t }))} bare />,
    );
    const root = container.firstElementChild as HTMLElement;
    const footnote = [...root.querySelectorAll("p")].find((p) =>
      /business ·/.test(p.textContent ?? ""),
    );
    expect(footnote, "the mix footnote is gone").toBeDefined();
    const region = containingScrollRegion(root.querySelector("ul") as HTMLElement, root);
    expect(region, "the type bars are in no scrolling region at all").not.toBeNull();
    expect(region!.contains(footnote!)).toBe(false);
  });
});
