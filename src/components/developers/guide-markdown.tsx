import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/** `### invalid_request` → `invalid_request`, `## 1. Get a token` → `1-get-a-token`. */
export function headingId(children: ReactNode): string {
  const text = flatten(children);
  return text.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "");
}

function flatten(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  if (node && typeof node === "object" && "props" in node) {
    return flatten((node.props as { children?: ReactNode }).children);
  }
  return "";
}

const components: Components = {
  h2: ({ children }) => <h2 id={headingId(children)} className="scroll-mt-20">{children}</h2>,
  h3: ({ children }) => <h3 id={headingId(children)} className="scroll-mt-20">{children}</h3>,
  a: ({ href = "", children }) =>
    href.startsWith("/developers") ? (
      <Link href={href}>{children}</Link>
    ) : (
      <a href={href} {...(/^https?:/.test(href) && { target: "_blank", rel: "noreferrer" })}>{children}</a>
    ),
};

/**
 * Markdown for the /developers guides and API changelog. Server-rendered,
 * GFM tables, no raw HTML. Headings get ids so a problem's `type`
 * (/developers/guides/errors#<code>) lands on its section.
 */
export function GuideMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none break-words prose-headings:font-semibold prose-a:underline",
        "prose-code:before:content-none prose-code:after:content-none prose-pre:overflow-x-auto",
        className,
      )}
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
