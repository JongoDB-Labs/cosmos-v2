"use client";

import { useState } from "react";
import {
  LexicalComposer,
  type InitialConfigType,
} from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
} from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { LinkNode, AutoLinkNode } from "@lexical/link";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import type { Klass, LexicalNode } from "lexical";
import { MentionNode } from "./mention-node";
import { notesTransformers } from "./markdown";
import { noteEditorTheme } from "./theme";
import { ToolbarPlugin } from "./toolbar";
import { MentionPlugin } from "./mention-plugin";
import type { OrgUser } from "@/components/chat/mention-typeahead";

const EDITOR_NODES: ReadonlyArray<Klass<LexicalNode>> = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  AutoLinkNode,
  CodeNode,
  CodeHighlightNode,
  MentionNode,
];

/**
 * WYSIWYG rich-text editor for notes. Canonical content stays MARKDOWN: the
 * initial value is imported via the shared transformers and every change is
 * exported back to markdown via `onChange` (so search, RAG embeddings and the
 * `<@uuid>` mention fan-out are unchanged). Replaces the old markdown-textarea
 * + split write/preview, fixing the toggle (Bug 1) and combined-emphasis
 * (Bug 2) classes of bug natively.
 *
 * Mount only AFTER members have loaded so the initial import resolves mention
 * display names (see NoteEditor).
 */
export function NoteRichTextEditor({
  initialMarkdown,
  members,
  onChange,
  placeholder = "Start writing… (Markdown supported · @ to mention)",
}: {
  initialMarkdown: string;
  members: OrgUser[];
  onChange: (markdown: string) => void;
  placeholder?: string;
}) {
  // Computed once: this component is keyed per note, and only mounts after
  // members load, so the member map is complete for the initial import.
  const [transformers] = useState(() =>
    notesTransformers(
      new Map(members.map((m) => [m.id.toLowerCase(), m.displayName])),
    ),
  );

  const [initialConfig] = useState<InitialConfigType>(() => ({
    namespace: "note-editor",
    theme: noteEditorTheme,
    onError: (error: Error) => {
      // Surface in dev; never throw past the boundary in prod.
      console.error("Lexical error:", error);
    },
    nodes: [...EDITOR_NODES],
    editorState: () => $convertFromMarkdownString(initialMarkdown, transformers),
  }));

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="flex flex-1 min-h-0 flex-col gap-2">
        <div className="border-b pb-2">
          <ToolbarPlugin />
        </div>
        <div className="relative flex-1 min-h-0 overflow-y-auto">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                aria-label="Note content"
                className="min-h-[300px] text-sm leading-relaxed outline-none [&_*]:outline-none"
              />
            }
            placeholder={
              <div className="pointer-events-none absolute left-0 top-0 text-sm text-muted-foreground">
                {placeholder}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin />
      <MarkdownShortcutPlugin transformers={transformers} />
      <MentionPlugin members={members} />
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(editorState) => {
          editorState.read(() => {
            onChange($convertToMarkdownString(transformers));
          });
        }}
      />
    </LexicalComposer>
  );
}
