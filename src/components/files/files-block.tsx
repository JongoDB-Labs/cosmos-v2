"use client";

import type { ElementType } from "react";
import { RoadmapMarkdown } from "@/components/roadmap/roadmap-markdown";
import { cn } from "@/lib/utils";

export interface DocBlock {
  id: string;
  kind: string;
  level: number | null;
  text: string;
  html: string | null;
  data: unknown;
  anchor: string;
  page: number | null;
}

const HEADING_SIZE: Record<number, string> = {
  1: "text-xl",
  2: "text-lg",
  3: "text-base",
  4: "text-sm",
};

/** Render one normalized DocumentBlock. Each block carries its `anchor` id so the
 *  outline + deep-links can scroll to it. */
export function FilesBlock({ block }: { block: DocBlock }) {
  if (block.kind === "HEADING") {
    const level = Math.min(Math.max(block.level ?? 2, 1), 4);
    const Tag = `h${level}` as ElementType;
    return (
      <Tag
        id={block.anchor}
        className={cn("scroll-mt-20 font-semibold text-[var(--text)]", HEADING_SIZE[level])}
      >
        {block.text}
      </Tag>
    );
  }

  if (block.kind === "PAGE_BREAK") {
    return (
      <div className="my-4 flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <hr className="flex-1 border-[var(--border)]" />
        {block.page ? `page ${block.page}` : ""}
        <hr className="flex-1 border-[var(--border)]" />
      </div>
    );
  }

  if (block.kind === "TABLE") {
    const rows = ((block.data as { rows?: string[][] })?.rows ?? []) as string[][];
    return (
      <div id={block.anchor} className="scroll-mt-20 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-[var(--border)]">
                {r.map((c, j) =>
                  i === 0 ? (
                    <th key={j} className="px-2 py-1 text-left font-medium text-[var(--text)]">
                      {c}
                    </th>
                  ) : (
                    <td key={j} className="px-2 py-1 text-[var(--text)]">
                      {c}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (block.kind === "CODE") {
    return (
      <pre
        id={block.anchor}
        className="scroll-mt-20 overflow-x-auto rounded bg-[var(--surface)] p-3 text-xs text-[var(--text)]"
      >
        {block.text}
      </pre>
    );
  }

  // PARAGRAPH, QUOTE, LIST, IMAGE → markdown text.
  return (
    <div id={block.anchor} className="scroll-mt-20">
      <RoadmapMarkdown>{block.text}</RoadmapMarkdown>
    </div>
  );
}
