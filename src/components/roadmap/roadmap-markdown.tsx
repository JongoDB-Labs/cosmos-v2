"use client";

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
        "prose prose-sm dark:prose-invert max-w-none break-words",
        "prose-headings:font-semibold prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
