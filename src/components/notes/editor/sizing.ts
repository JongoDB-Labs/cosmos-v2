import type { CSSProperties } from "react";

/**
 * How tall the rich-text editor's editable area may be.
 *
 * The editor is used in two very different places and they want opposite things.
 * A note fills its pane, so a generous resting height is right. A COMMENT
 * COMPOSER is an inline control on the work-item detail sheet: it should sit
 * small until there's something to say, grow with the text, and stop growing
 * before it eats the sheet. It used to inherit the note's 300px resting height,
 * which is the reported bug — "let the input box grow as needed rather than
 * having one statically defined huge input box".
 *
 * The growth itself needs no JS: a contenteditable is content-sized already, and
 * the `Textarea` primitive gets the same behaviour from `field-sizing: content`.
 * All that's needed is the floor and the ceiling — a resting height to grow FROM
 * and a cap to scroll AT — which is what this module owns, so the two call sites
 * can't drift apart and a fixed height can't creep back in unnoticed.
 */
export interface EditorSizing {
  /** Resting height in px: what an EMPTY editor occupies. */
  minHeight: number;
  /** Cap in px; past it the editor scrolls internally instead of growing. */
  maxHeight?: number;
}

/**
 * A note editor: fills the pane it's given, growth bounded by that pane rather
 * than by a cap of its own.
 */
export const NOTE_EDITOR_SIZING: EditorSizing = { minHeight: 300 };

/**
 * An inline composer (work-item comments): about two lines at rest, growing to
 * roughly ten before it scrolls internally — so a long comment is comfortable
 * to write and a short one doesn't leave a crater in the sheet.
 */
export const COMMENT_EDITOR_SIZING: EditorSizing = { minHeight: 44, maxHeight: 240 };

/**
 * Split an {@link EditorSizing} into the two styles the editor applies: the cap
 * belongs on the scroll container, the resting height on the editable itself.
 */
export function editorSizingStyles(sizing: EditorSizing): {
  /** The scroll container — caps growth, then scrolls. */
  container: CSSProperties;
  /** The editable — the height it grows from. */
  editable: CSSProperties;
} {
  const { maxHeight } = sizing;
  // A resting height taller than the cap would put a scrollbar on an EMPTY
  // editor and make the cap a lie. The cap wins.
  const minHeight =
    maxHeight == null ? sizing.minHeight : Math.min(sizing.minHeight, maxHeight);

  return {
    container: maxHeight == null ? {} : { maxHeight },
    editable: { minHeight },
  };
}
