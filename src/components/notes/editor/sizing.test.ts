import { describe, it, expect } from "vitest";
import {
  editorSizingStyles,
  COMMENT_EDITOR_SIZING,
  NOTE_EDITOR_SIZING,
} from "./sizing";

describe("editorSizingStyles", () => {
  it("puts the resting height on the editable and the cap on the scroller", () => {
    const { container, editable } = editorSizingStyles({ minHeight: 44, maxHeight: 240 });
    expect(editable.minHeight).toBe(44);
    expect(container.maxHeight).toBe(240);
  });

  it("leaves the scroller uncapped when no cap is asked for", () => {
    const { container, editable } = editorSizingStyles({ minHeight: 300 });
    expect(editable.minHeight).toBe(300);
    expect(container.maxHeight).toBeUndefined();
  });

  it("lets the cap win over a taller resting height", () => {
    // Otherwise an EMPTY editor would already overflow its own cap and show a
    // scrollbar with nothing in it.
    const { container, editable } = editorSizingStyles({ minHeight: 300, maxHeight: 120 });
    expect(editable.minHeight).toBe(120);
    expect(container.maxHeight).toBe(120);
  });
});

describe("the presets", () => {
  // The reported bug: the comment composer inherited the note editor's 300px
  // resting height, so every ticket had a crater where the composer should be.
  it("gives the comment composer a small resting height, not the note's", () => {
    expect(COMMENT_EDITOR_SIZING.minHeight).toBeLessThan(NOTE_EDITOR_SIZING.minHeight);
    // Two lines of 14px/1.625 text plus breathing room — not a paragraph.
    expect(COMMENT_EDITOR_SIZING.minHeight).toBeLessThanOrEqual(64);
  });

  it("caps the comment composer so a long comment scrolls instead of eating the sheet", () => {
    expect(COMMENT_EDITOR_SIZING.maxHeight).toBeDefined();
    expect(COMMENT_EDITOR_SIZING.maxHeight!).toBeGreaterThan(
      COMMENT_EDITOR_SIZING.minHeight,
    );
  });

  it("leaves the note editor uncapped — its pane bounds it", () => {
    expect(NOTE_EDITOR_SIZING.maxHeight).toBeUndefined();
  });
});
