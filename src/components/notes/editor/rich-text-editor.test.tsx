// @vitest-environment jsdom
//
// BR: "let the input box grow as needed rather than having one statically
// defined huge input box" — the work-item comment composer is this editor, and
// it inherited the note editor's 300px resting height, so every ticket showed a
// 300px-tall empty box. Growth itself is free (a contenteditable is
// content-sized); what the composer needed was a small floor and a ceiling.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme" }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: () => Promise.resolve([]) }));
vi.mock("@/components/mentions/entity-mention-picker", () => ({
  EntityMentionPicker: () => null,
}));

import { NoteRichTextEditor } from "./rich-text-editor";
import { COMMENT_EDITOR_SIZING } from "./sizing";

afterEach(cleanup);

function renderEditor(props: Partial<React.ComponentProps<typeof NoteRichTextEditor>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NoteRichTextEditor
        initialMarkdown=""
        orgId="o1"
        mentionLabels={new Map()}
        onChange={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

/** The editable's own scroll container (where the growth cap lives). */
function scrollerOf(editable: HTMLElement): HTMLElement {
  const el = editable.closest('[data-slot="editor-scroller"]');
  if (!(el instanceof HTMLElement)) throw new Error("no editor scroller around the editable");
  return el;
}

describe("NoteRichTextEditor sizing", () => {
  it("defaults to the full-pane note height, uncapped", () => {
    renderEditor();
    const editable = screen.getByRole("textbox", { name: "Note content" });
    expect(editable.style.minHeight).toBe("300px");
    expect(scrollerOf(editable).style.maxHeight).toBe("");
  });

  it("takes a compact resting height from the caller — the comment composer's fix", () => {
    renderEditor({ ariaLabel: "Comment", sizing: COMMENT_EDITOR_SIZING });
    const editable = screen.getByRole("textbox", { name: "Comment" });
    expect(editable.style.minHeight).toBe(`${COMMENT_EDITOR_SIZING.minHeight}px`);
    // The old 300px floor is what made it a crater; it must be gone.
    expect(editable.style.minHeight).not.toBe("300px");
    expect(editable.className).not.toContain("min-h-[300px]");
  });

  it("caps growth on the scroll container so a long comment scrolls in place", () => {
    renderEditor({ ariaLabel: "Comment", sizing: COMMENT_EDITOR_SIZING });
    const scroller = scrollerOf(screen.getByRole("textbox", { name: "Comment" }));
    expect(scroller.style.maxHeight).toBe(`${COMMENT_EDITOR_SIZING.maxHeight}px`);
    // Capped height without an internal scroller would just clip the text.
    expect(scroller.className).toContain("overflow-y-auto");
  });

  it("names the editable region for whatever is being written", () => {
    // A comment composer labelled "Note content" is a lie to a screen reader.
    renderEditor({ ariaLabel: "Comment" });
    expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Note content" })).toBeNull();
  });
});
