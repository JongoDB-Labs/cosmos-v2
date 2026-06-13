"use client";

import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Shared Markdown renderer for roadmap bodies and work-item descriptions.
 * GFM (links, tables, lists) via remark-gfm; NO raw HTML (react-markdown ignores
 * it by default) so user/LLM-authored content can't inject markup. Internal
 * roadmap deep-links (e.g. [R-19](/org/projects/KEY/roadmap/r-19)) render as
 * normal anchors and navigate client-side.
 */
export function RoadmapMarkdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none break-words prose-headings:font-semibold prose-a:underline",
        className,
      )}
      // Bind the typography plugin's color vars to the app's theme tokens so body
      // text is the same crisp `--text` as titles in BOTH light and dark mode — the
      // plugin's grey defaults (gray-700) wash out against the light surface. Every
      // value is a mode-aware CSS var, so this replaces `dark:prose-invert`.
      style={
        {
          "--tw-prose-body": "var(--text)",
          "--tw-prose-headings": "var(--text)",
          "--tw-prose-bold": "var(--text)",
          "--tw-prose-links": "var(--status-progress-text, var(--status-progress))",
          "--tw-prose-bullets": "var(--text-muted)",
          "--tw-prose-counters": "var(--text-muted)",
          "--tw-prose-quotes": "var(--text)",
          "--tw-prose-quote-borders": "var(--border)",
          "--tw-prose-hr": "var(--border)",
          "--tw-prose-code": "var(--text)",
          "--tw-prose-th-borders": "var(--border)",
          "--tw-prose-td-borders": "var(--border)",
        } as CSSProperties
      }
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
