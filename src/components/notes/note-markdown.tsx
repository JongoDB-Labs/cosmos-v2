/**
 * Plain-text helpers for notes. The live note rendering now lives in the Lexical
 * editor (`./editor/`), so the former `NoteMarkdown` document renderer — and its
 * dependency on the chat `renderInline` tokenizer — has been removed. Only the
 * list-preview stripper remains.
 */

/**
 * Strip markdown syntax to readable plain text for compact list previews
 * (where rendering block elements inside a line-clamp would break layout).
 */
export function stripMarkdown(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/<@([0-9a-f-]{36})>/gi, "@mention") // mention tokens
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^[-*]\s+/gm, "") // bullet markers
    .replace(/^\d+\.\s+/gm, "") // numbered markers
    .replace(/^>\s?/gm, "") // quote markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // italic
    .replace(/~(.*?)~/g, "$1") // strike
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → text
    .replace(/\s+/g, " ")
    .trim();
}
