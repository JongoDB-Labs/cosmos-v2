"use client";

import { useCallback, useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister, $getNearestNodeOfType } from "@lexical/utils";
import {
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  COMMAND_PRIORITY_LOW,
  type TextFormatType,
} from "lexical";
import { $setBlocksType } from "@lexical/selection";
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  type HeadingTagType,
} from "@lexical/rich-text";
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
  ListNode,
} from "@lexical/list";
import { $isLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Quote,
  Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type BlockKind = "paragraph" | "h1" | "h2" | "quote" | "ul" | "ol";

/**
 * Formatting toolbar. Every button is a TRUE on/off toggle and reflects the
 * current selection's active state (pressed highlight) — fixing the old
 * markdown-textarea toolbar where buttons only ever inserted markers.
 */
export function ToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  const [strikethrough, setStrikethrough] = useState(false);
  const [code, setCode] = useState(false);
  const [isLink, setIsLink] = useState(false);
  const [block, setBlock] = useState<BlockKind>("paragraph");

  const $updateToolbar = useCallback(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;

    setBold(selection.hasFormat("bold"));
    setItalic(selection.hasFormat("italic"));
    setStrikethrough(selection.hasFormat("strikethrough"));
    setCode(selection.hasFormat("code"));

    const anchorNode = selection.anchor.getNode();
    const element =
      anchorNode.getKey() === "root"
        ? anchorNode
        : anchorNode.getTopLevelElementOrThrow();

    let kind: BlockKind = "paragraph";
    if ($isHeadingNode(element)) {
      kind = element.getTag() === "h1" ? "h1" : "h2";
    } else if ($isQuoteNode(element)) {
      kind = "quote";
    } else {
      const listNode = $getNearestNodeOfType<ListNode>(anchorNode, ListNode);
      if (listNode) kind = listNode.getListType() === "number" ? "ol" : "ul";
    }
    setBlock(kind);

    const node = selection.anchor.getNode();
    setIsLink($isLinkNode(node) || $isLinkNode(node.getParent()));
  }, []);

  useEffect(() => {
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read($updateToolbar);
      }),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          $updateToolbar();
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor, $updateToolbar]);

  const formatText = (fmt: TextFormatType) =>
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, fmt);

  const toHeading = (tag: HeadingTagType, active: boolean) =>
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () =>
          active ? $createParagraphNode() : $createHeadingNode(tag),
        );
      }
    });

  const toQuote = (active: boolean) =>
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () =>
          active ? $createParagraphNode() : $createQuoteNode(),
        );
      }
    });

  const toList = (type: "ul" | "ol", active: boolean) => {
    if (active) editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    else if (type === "ul")
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    else editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
  };

  const toggleLink = () => {
    if (isLink) {
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
      return;
    }
    const url = window.prompt("Link URL");
    if (url) editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
  };

  const items: { key: string; icon: typeof Bold; label: string; active: boolean; on: () => void }[] = [
    { key: "bold", icon: Bold, label: "Bold", active: bold, on: () => formatText("bold") },
    { key: "italic", icon: Italic, label: "Italic", active: italic, on: () => formatText("italic") },
    { key: "strikethrough", icon: Strikethrough, label: "Strikethrough", active: strikethrough, on: () => formatText("strikethrough") },
    { key: "code", icon: Code, label: "Inline code", active: code, on: () => formatText("code") },
    { key: "h1", icon: Heading1, label: "Heading 1", active: block === "h1", on: () => toHeading("h1", block === "h1") },
    { key: "h2", icon: Heading2, label: "Heading 2", active: block === "h2", on: () => toHeading("h2", block === "h2") },
    { key: "ul", icon: List, label: "Bulleted list", active: block === "ul", on: () => toList("ul", block === "ul") },
    { key: "ol", icon: ListOrdered, label: "Numbered list", active: block === "ol", on: () => toList("ol", block === "ol") },
    { key: "quote", icon: Quote, label: "Quote", active: block === "quote", on: () => toQuote(block === "quote") },
    { key: "link", icon: Link2, label: "Link", active: isLink, on: toggleLink },
  ];

  return (
    <div className="flex flex-wrap items-center gap-0.5">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            size="icon-sm"
            title={item.label}
            aria-label={item.label}
            aria-pressed={item.active}
            onClick={item.on}
            className={cn(item.active && "bg-accent text-accent-foreground")}
          >
            <Icon className="h-4 w-4" />
          </Button>
        );
      })}
    </div>
  );
}
