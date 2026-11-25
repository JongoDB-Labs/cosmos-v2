// The stacking scale for viewport-fixed UI (src/lib/ui/layers.ts).
//
// The assistant drawer used to share z-40 with page bars and lose to
// full-screen views at z-50, so a full-screen timeline covered an open drawer
// and the Preferences save bar slid under it. jsdom computes no stacking, so
// what is checkable is the numbers and that the surfaces use them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYER, Z_ASSISTANT, Z_MOBILE_NAV, Z_PAGE_FLOAT, Z_TAKEOVER } from "./layers";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("layer scale", () => {
  it("orders overlay > assistant > pageFloat > takeover > mobileNav", () => {
    expect(LAYER.overlay).toBeGreaterThan(LAYER.assistant);
    expect(LAYER.assistant).toBeGreaterThan(LAYER.pageFloat);
    expect(LAYER.pageFloat).toBeGreaterThan(LAYER.takeover);
    expect(LAYER.takeover).toBeGreaterThan(LAYER.mobileNav);
  });

  it("each class literal matches its number", () => {
    const n = (c: string) => Number(/z-\[?(\d+)\]?/.exec(c)![1]);
    expect(n(Z_ASSISTANT)).toBe(LAYER.assistant);
    expect(n(Z_PAGE_FLOAT)).toBe(LAYER.pageFloat);
    expect(n(Z_TAKEOVER)).toBe(LAYER.takeover);
    expect(n(Z_MOBILE_NAV)).toBe(LAYER.mobileNav);
  });

  it.each([
    ["src/components/drawers/docked-drawer.tsx", "Z_ASSISTANT"],
    ["src/components/drawers/drawer-tab.tsx", "Z_ASSISTANT"],
    ["src/components/layouts/floating-agent-bubble.tsx", "Z_ASSISTANT"],
    ["src/components/boards/timeline/timeline-view.tsx", "Z_TAKEOVER"],
    ["src/components/boards/ceremony/ceremony-board.tsx", "Z_TAKEOVER"],
    ["src/components/settings/preferences-form.tsx", "Z_PAGE_FLOAT"],
    ["src/components/layouts/mobile-bottom-nav.tsx", "Z_MOBILE_NAV"],
  ])("%s uses %s, not a bare number on its fixed layer", (file, constant) => {
    const src = read(file);
    expect(src).toContain(constant);
    const fixedLines = src.split("\n").filter((l) => /\bfixed\b/.test(l) && /\binset|right-0|bottom-/.test(l));
    for (const l of fixedLines) expect(l, l.trim()).not.toMatch(/\bz-(40|50)\b/);
  });

  it.each([
    "dialog",
    "sheet",
    "dropdown-menu",
    "select",
    "tooltip",
    "date-picker",
    "searchable-select",
    "searchable-multi-select",
  ])("portaled primitive %s still sits at the overlay layer (z-50)", (name) => {
    // If the assistant is ever raised to or past 50, its own model picker and
    // menus (portaled at this layer) would open behind it.
    expect(read(`src/components/ui/${name}.tsx`)).toMatch(/\bz-50\b/);
  });
});
