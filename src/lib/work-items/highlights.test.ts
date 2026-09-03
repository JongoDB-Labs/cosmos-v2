import { describe, it, expect } from "vitest";
import {
  WORK_ITEM_HIGHLIGHTS,
  WORK_ITEM_HIGHLIGHT_ORDER,
  highlightColor,
  highlightLabel,
  highlightRowStyle,
  highlightStyle,
  isWorkItemHighlight,
  type WorkItemHighlight,
} from "./highlights";

describe("isWorkItemHighlight", () => {
  it("accepts every key in the registry", () => {
    for (const key of Object.keys(WORK_ITEM_HIGHLIGHTS)) {
      expect(isWorkItemHighlight(key)).toBe(true);
    }
  });

  it("rejects a value a NEWER build might have written", () => {
    // The column is plain TEXT with no CHECK constraint, so the database will
    // happily store a key this build has never heard of. Narrowing here is the
    // only thing standing between that row and a render-time crash.
    expect(isWorkItemHighlight("FUCHSIA_FROM_A_NEWER_BUILD")).toBe(false);
  });

  it("rejects null, undefined and non-strings", () => {
    expect(isWorkItemHighlight(null)).toBe(false);
    expect(isWorkItemHighlight(undefined)).toBe(false);
    expect(isWorkItemHighlight(42)).toBe(false);
    expect(isWorkItemHighlight("")).toBe(false);
  });

  it("is case-sensitive — storage is the upper-case key", () => {
    expect(isWorkItemHighlight("amber")).toBe(false);
    expect(isWorkItemHighlight("AMBER")).toBe(true);
  });

  it("does not accept inherited Object properties", () => {
    // `key in obj` walks the prototype chain, so "toString" and "constructor"
    // would both pass a naive `value in WORK_ITEM_HIGHLIGHTS` on a plain object
    // literal. This asserts the registry cannot be fooled that way.
    expect(isWorkItemHighlight("toString")).toBe(false);
    expect(isWorkItemHighlight("constructor")).toBe(false);
    expect(isWorkItemHighlight("hasOwnProperty")).toBe(false);
  });
});

describe("highlightColor / highlightLabel", () => {
  it("resolves a key to a themed CSS variable reference", () => {
    expect(highlightColor("AMBER")).toBe("var(--status-blocked-text)");
  });

  it("resolves a key to its meaning", () => {
    expect(highlightLabel("AMBER")).toBe("At risk");
    expect(highlightLabel("GREEN")).toBe("On track");
    expect(highlightLabel("RED")).toBe("Blocked");
  });

  it("returns null for no highlight and for an unknown one", () => {
    expect(highlightColor(null)).toBeNull();
    expect(highlightColor("NOPE")).toBeNull();
    expect(highlightLabel(null)).toBeNull();
    expect(highlightLabel("NOPE")).toBeNull();
  });
});

describe("highlightStyle", () => {
  it("recolours the card's existing border AND adds an inset ring", () => {
    const style = highlightStyle("RED");
    expect(style).toEqual({
      borderColor: "var(--status-critical-text)",
      boxShadow: "inset 0 0 0 2px var(--status-critical-text)",
    });
  });

  it("is undefined (not an empty object) with no highlight, so no style attr is emitted", () => {
    expect(highlightStyle(null)).toBeUndefined();
    expect(highlightStyle(undefined)).toBeUndefined();
    expect(highlightStyle("")).toBeUndefined();
  });

  it("is undefined for an unrecognised stored value rather than painting garbage", () => {
    // `borderColor: "var(--undefined-thing)"` would silently render as
    // `currentColor`, i.e. a highlight nobody asked for on an arbitrary card.
    expect(highlightStyle("FUCHSIA_FROM_A_NEWER_BUILD")).toBeUndefined();
  });

  it("uses an INSET shadow — an outer ring double-borders the card and clips", () => {
    // Board columns scroll; an outer ring is cut off by the scroll container.
    expect(highlightStyle("GREEN")!.boxShadow).toMatch(/^inset /);
  });
});

describe("highlightRowStyle", () => {
  it("marks a row with a left edge and a wash, not a full outline", () => {
    const style = highlightRowStyle("AMBER")!;
    expect(style.borderLeftWidth).toBe(3);
    expect(style.borderLeftStyle).toBe("solid");
    expect(style.borderLeftColor).toBe("var(--status-blocked-text)");
    expect(style.backgroundColor).toBe(
      "color-mix(in oklab, var(--status-blocked-text) 12%, transparent)",
    );
  });

  it("does NOT use box-shadow — a <tr> under border-collapse may not paint one", () => {
    expect(highlightRowStyle("AMBER")).not.toHaveProperty("boxShadow");
  });

  it("washes into `transparent`, so selection and zebra striping survive", () => {
    // Mixing into a solid colour would erase the row-selected background.
    expect(highlightRowStyle("RED")!.backgroundColor).toContain("transparent");
  });

  it("is undefined with no highlight and for an unknown value", () => {
    expect(highlightRowStyle(null)).toBeUndefined();
    expect(highlightRowStyle("FUCHSIA_FROM_A_NEWER_BUILD")).toBeUndefined();
  });

  it("agrees with the card style on which colour a key means", () => {
    // Two shapes, ONE palette. If these ever disagree the same item reads as a
    // different status depending on which board you opened.
    for (const key of WORK_ITEM_HIGHLIGHT_ORDER) {
      expect(highlightRowStyle(key)!.borderLeftColor).toBe(highlightStyle(key)!.borderColor);
    }
  });
});

describe("the registry itself", () => {
  it("orders every key exactly once", () => {
    const keys = Object.keys(WORK_ITEM_HIGHLIGHTS).sort();
    expect([...WORK_ITEM_HIGHLIGHT_ORDER].sort()).toEqual(keys);
    expect(new Set(WORK_ITEM_HIGHLIGHT_ORDER).size).toBe(WORK_ITEM_HIGHLIGHT_ORDER.length);
  });

  it("gives every colour a distinct meaning and a distinct variable", () => {
    const labels = WORK_ITEM_HIGHLIGHT_ORDER.map((k) => WORK_ITEM_HIGHLIGHTS[k].label);
    const vars = WORK_ITEM_HIGHLIGHT_ORDER.map((k) => WORK_ITEM_HIGHLIGHTS[k].cssVar);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it("only uses --status-*-text variables, which globals.css defines for BOTH themes", () => {
    // The bare --status-* fills are chart colours and are NOT redefined under
    // dark mode; only the -text set is. Using a bare fill here would give a
    // dark-mode reader a border tuned for a white card.
    for (const key of WORK_ITEM_HIGHLIGHT_ORDER) {
      expect(WORK_ITEM_HIGHLIGHTS[key].cssVar).toMatch(/^--status-[a-z]+-text$/);
    }
  });

  it("keeps the stored key colour-named, not meaning-named", () => {
    // Storage is the durable half. A key like AT_RISK would need a data
    // migration the first time a team renamed the label.
    for (const key of WORK_ITEM_HIGHLIGHT_ORDER) {
      expect(key).toMatch(/^(GREEN|AMBER|RED|BLUE|PURPLE|GREY)$/);
    }
  });

  it("exposes a type that only admits registry keys", () => {
    const ok: WorkItemHighlight = "AMBER";
    expect(isWorkItemHighlight(ok)).toBe(true);
  });
});
