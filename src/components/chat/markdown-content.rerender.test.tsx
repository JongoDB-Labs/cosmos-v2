// @vitest-environment jsdom
//
// BR: typing a new comment made an EARLIER comment's links and @mention chips
// multiply, one extra copy per keystroke.
//
// `MarkdownContent` puts every line of a paragraph into ONE <p>, and the inline
// tokenizer keyed each token by where it starts in ITS OWN line. Two lines that
// both start with a link therefore both produced the key `0-a`: duplicate keys
// among siblings. The work-item sheet holds the composer draft in its own state,
// so every keystroke re-renders every comment, and on each re-render React left
// one orphaned copy behind.
//
// Every count here is EXACT and is checked after the first render too: the
// first render is the positive control that the probe sees the tokens at all,
// and "at least N" would pass on the bug.
import { describe, it, expect, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { refKey } from "@/lib/mentions/refs";
import { MarkdownContent, type RefMap } from "./markdown-content";

vi.mock("@/components/notes/editor/rich-text-editor", () => ({
  NoteRichTextEditor: () => null,
}));

import { CommentItem } from "@/components/comments/comment-item";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RERENDERS = 5;

const REFS: RefMap = new Map([
  [refKey("user", "u-ada"), { type: "user", id: "u-ada", label: "Ada", url: null }],
  [refKey("user", "u-grace"), { type: "user", id: "u-grace", label: "Grace", url: null }],
  [
    refKey("workItem", "wi-1"),
    { type: "workItem", id: "wi-1", label: "First item", url: "/acme/work-items/wi-1" },
  ],
  [
    refKey("workItem", "wi-2"),
    { type: "workItem", id: "wi-2", label: "Second item", url: "/acme/work-items/wi-2" },
  ],
]);

/** React's dev-mode complaint about two siblings sharing a key. */
function spyDuplicateKeyWarnings(): () => number {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () =>
    spy.mock.calls.filter((args) => args.some((a) => String(a).includes("same key"))).length;
}

/**
 * Render once, then re-render RERENDERS times with the SAME props, as a sibling
 * composer's keystrokes do. Returns the probe's reading after every render.
 */
function readingsAcrossRerenders(
  content: string,
  probe: (root: HTMLElement) => number,
): { readings: number[]; texts: string[] } {
  const { container, rerender } = render(<MarkdownContent content={content} refMap={REFS} />);
  const readings = [probe(container)];
  const texts = [container.textContent ?? ""];
  for (let k = 0; k < RERENDERS; k++) {
    rerender(<MarkdownContent content={content} refMap={REFS} />);
    readings.push(probe(container));
    texts.push(container.textContent ?? "");
  }
  return { readings, texts };
}

const count = (selector: string) => (root: HTMLElement) => root.querySelectorAll(selector).length;

const CASES: Array<{ name: string; content: string; probe: (root: HTMLElement) => number; expected: number }> = [
  {
    name: "two lines that each start with a bare url",
    content: "https://example.com/a\nhttps://example.com/b",
    probe: count("a"),
    expected: 2,
  },
  {
    name: "two lines that each start with a markdown link",
    content: "[spec](https://example.com/spec)\n[plan](https://example.com/plan)",
    probe: count("a"),
    expected: 2,
  },
  {
    name: "three lines with a url at the same offset mid-line",
    content: "see https://example.com/a\nsee https://example.com/b\nsee https://example.com/c",
    probe: count("a"),
    expected: 3,
  },
  {
    name: "two lines that each start with a person mention",
    content: "<@u-ada> can you look\n<@u-grace> and you",
    probe: (root) => within(root).queryAllByText(/^@(Ada|Grace)$/).length,
    expected: 2,
  },
  {
    name: "two lines that each start with a linked entity mention",
    content: "<@workItem:wi-1> blocks this\n<@workItem:wi-2> too",
    probe: count("a"),
    expected: 2,
  },
  { name: "two lines of bold", content: "**one**\n**two**", probe: count("strong"), expected: 2 },
  { name: "two lines of italic", content: "*one*\n*two*", probe: count("em"), expected: 2 },
  { name: "two lines of strike", content: "~one~\n~two~", probe: count("s"), expected: 2 },
  { name: "two lines of inline code", content: "`one`\n`two`", probe: count("code"), expected: 2 },
];

describe("MarkdownContent re-rendered with the same props", () => {
  it.each(CASES)("$name keeps exactly $expected tokens", ({ content, probe, expected }) => {
    const duplicateKeyWarnings = spyDuplicateKeyWarnings();
    const { readings, texts } = readingsAcrossRerenders(content, probe);
    expect(readings).toEqual(Array(RERENDERS + 1).fill(expected));
    // Nothing else was duplicated either: the text is what the first render showed.
    expect(new Set(texts).size).toBe(1);
    expect(duplicateKeyWarnings()).toBe(0);
  });

  it("keeps the paragraph's DOM shape: one <p>, a <br> between lines", () => {
    const { container } = render(
      <MarkdownContent content={"https://example.com/a\nhttps://example.com/b"} refMap={REFS} />,
    );
    expect(container.querySelectorAll("p")).toHaveLength(1);
    const p = container.querySelector("p")!;
    expect(p.className).toBe("whitespace-pre-wrap");
    expect(Array.from(p.childNodes, (n) => n.nodeName)).toEqual(["A", "BR", "A"]);
    expect(Array.from(p.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });
});

describe("a comment while someone types in the composer below it", () => {
  // The reported path end to end: the composer's draft lives in the parent, so
  // each keystroke re-renders the CommentItem above it.
  function Thread({ comment }: { comment: string }) {
    const [draft, setDraft] = useState("");
    return (
      <>
        <CommentItem
          authorName="Carol"
          createdAt="2026-10-23T10:00:00.000Z"
          edited={false}
          content={comment}
          refMap={REFS}
          orgId="o1"
          mentionLabels={new Map()}
          canEdit={false}
          canDelete={false}
          onSave={async () => true}
          onDelete={() => {}}
        />
        <textarea aria-label="Composer" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </>
    );
  }

  it("shows the same links after five keystrokes as before", () => {
    const duplicateKeyWarnings = spyDuplicateKeyWarnings();
    render(<Thread comment={"https://example.com/a\nhttps://example.com/b"} />);
    const composer = screen.getByRole("textbox", { name: "Composer" });
    const links = () => screen.queryAllByRole("link").length;

    const readings = [links()];
    for (const draft of ["h", "he", "hel", "hell", "hello"]) {
      fireEvent.change(composer, { target: { value: draft } });
      readings.push(links());
    }
    // Positive control that the keystrokes really landed in the parent's state.
    expect(composer).toHaveValue("hello");
    expect(readings).toEqual([2, 2, 2, 2, 2, 2]);
    expect(duplicateKeyWarnings()).toBe(0);
  });
});
