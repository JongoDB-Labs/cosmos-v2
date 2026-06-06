import { describe, it, expect } from "vitest";
import { createHeadlessEditor } from "@lexical/headless";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
} from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { LinkNode } from "@lexical/link";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { $getRoot, $nodesOfType, TextNode } from "lexical";
import { MentionNode } from "./mention-node";
import { notesTransformers } from "./markdown";

function makeEditor() {
  return createHeadlessEditor({
    namespace: "notes-test",
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      LinkNode,
      CodeNode,
      CodeHighlightNode,
      MentionNode,
    ],
    onError: (e) => {
      throw e;
    },
  });
}

function roundTrip(md: string, mentionMap = new Map<string, string>()): string {
  const editor = makeEditor();
  const transformers = notesTransformers(mentionMap);
  editor.update(
    () => {
      $convertFromMarkdownString(md, transformers);
    },
    { discrete: true },
  );
  let out = "";
  editor.getEditorState().read(() => {
    out = $convertToMarkdownString(transformers);
  });
  return out;
}

describe("notes markdown round-trip", () => {
  it("preserves plain prose (a real seed note)", () => {
    const md =
      "ATO SSP package is the long pole and is now overdue. CAT II vuln remediation slipped.";
    expect(roundTrip(md)).toBe(md);
  });

  it("preserves headings", () => {
    expect(roundTrip("# Heading one")).toBe("# Heading one");
    expect(roundTrip("## Heading two")).toBe("## Heading two");
  });

  it("preserves bold and italic", () => {
    expect(roundTrip("**bold**")).toBe("**bold**");
    expect(roundTrip("*italic*")).toBe("*italic*");
  });

  it("renders combined bold+italic as 'both' with both formats, no stray asterisks (the reported bug)", () => {
    const out = roundTrip("***both***");
    // Re-importing the output must be stable (idempotent) — proves no literal
    // `*` leaks back into the text the way the old hand-rolled renderer did.
    expect(roundTrip(out)).toBe(out);

    const editor = makeEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(out, notesTransformers(new Map()));
      },
      { discrete: true },
    );

    let text = "";
    let bold = false;
    let italic = false;
    editor.getEditorState().read(() => {
      text = $getRoot().getTextContent();
      for (const node of $nodesOfType(TextNode)) {
        if (node.hasFormat("bold")) bold = true;
        if (node.hasFormat("italic")) italic = true;
      }
    });
    expect(text).toBe("both"); // no asterisks leaked into the rendered text
    expect(bold).toBe(true);
    expect(italic).toBe(true);
  });

  it("preserves inline code and strikethrough", () => {
    expect(roundTrip("`code`")).toBe("`code`");
    expect(roundTrip("~~struck~~")).toBe("~~struck~~");
  });

  it("preserves bulleted and numbered lists", () => {
    expect(roundTrip("- one\n- two")).toBe("- one\n- two");
    expect(roundTrip("1. one\n2. two")).toBe("1. one\n2. two");
  });

  it("preserves blockquotes", () => {
    expect(roundTrip("> quoted")).toBe("> quoted");
  });

  it("preserves links", () => {
    expect(roundTrip("[text](https://example.com)")).toBe(
      "[text](https://example.com)",
    );
  });

  it("preserves a <@uuid> mention as the same token", () => {
    const id = "f1244511-9f53-4a78-b4d0-91851b50de2e";
    const map = new Map([[id, "Jon Rannabargar"]]);
    const md = `Ping <@${id}> about the SSP`;
    expect(roundTrip(md, map)).toBe(md);
  });

  it("keeps the <@uuid> token even when the name is unknown", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const md = `cc <@${id}>`;
    expect(roundTrip(md)).toBe(md);
  });
});
