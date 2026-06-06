import type { EditorThemeClasses } from "lexical";

/**
 * Maps Lexical node types to Tailwind classes, mirroring the look of the
 * previous NoteMarkdown renderer so existing notes render unchanged.
 */
export const noteEditorTheme: EditorThemeClasses = {
  paragraph: "text-sm leading-relaxed mb-2 last:mb-0",
  heading: {
    h1: "text-xl font-semibold mt-4 mb-2 first:mt-0",
    h2: "text-lg font-semibold mt-4 mb-2 first:mt-0",
    h3: "text-base font-semibold mt-3 mb-1.5 first:mt-0",
    h4: "text-sm font-semibold mt-3 mb-1 first:mt-0",
    h5: "text-sm font-semibold mt-2 mb-1 first:mt-0",
    h6: "text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2 mb-1 first:mt-0",
  },
  quote: "border-l-2 border-border pl-3 my-2 text-sm text-muted-foreground",
  list: {
    ul: "list-disc pl-5 my-2 space-y-0.5",
    ol: "list-decimal pl-5 my-2 space-y-0.5",
    listitem: "text-sm leading-relaxed",
    nested: { listitem: "list-none" },
  },
  link: "text-primary underline",
  text: {
    bold: "font-semibold",
    italic: "italic",
    strikethrough: "line-through",
    code: "px-1 rounded bg-muted text-xs font-mono",
  },
  code: "block bg-muted text-xs p-3 rounded-md overflow-x-auto my-2 font-mono whitespace-pre-wrap",
};
