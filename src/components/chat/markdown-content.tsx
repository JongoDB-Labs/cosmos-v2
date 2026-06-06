"use client";
import React from "react";

/**
 * Render a small markdown subset to React elements. Supports:
 *   - `<@uuid>` mention tokens (resolved via mentionMap)
 *   - **bold**, *italic*, ~strike~
 *   - `inline code` and ```fenced code blocks```
 *   - > quoted lines
 *   - autolinks (https://...)
 *   - line breaks
 *
 * NO HTML output. Tokens render as React elements directly.
 * NO dangerouslySetInnerHTML.
 */

// Exported so the notes renderer (note-markdown.tsx) can reuse the exact same
// inline tokenizer (mentions / bold / italic / strike / code / links) and only
// add document-level blocks (headings, lists) on top.
export function renderInline(
  line: string,
  mentionMap: Map<string, string>,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  const re =
    /<@([0-9a-f-]{36})>|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~[^~]+~)|((?:https?:\/\/[^\s]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > i) out.push(line.slice(i, m.index));
    if (m[1]) {
      const name = mentionMap.get(m[1].toLowerCase()) ?? "user";
      out.push(
        <span
          key={`${m.index}-mention`}
          className="inline-block rounded bg-accent px-1 text-xs font-medium"
        >
          @{name}
        </span>,
      );
    } else if (m[2]) {
      out.push(
        <code
          key={`${m.index}-code`}
          className="px-1 rounded bg-muted text-xs"
        >
          {m[2].slice(1, -1)}
        </code>,
      );
    } else if (m[3]) {
      out.push(<strong key={`${m.index}-b`}>{m[3].slice(2, -2)}</strong>);
    } else if (m[4]) {
      out.push(<em key={`${m.index}-i`}>{m[4].slice(1, -1)}</em>);
    } else if (m[5]) {
      out.push(<s key={`${m.index}-s`}>{m[5].slice(1, -1)}</s>);
    } else if (m[6]) {
      out.push(
        <a
          key={`${m.index}-a`}
          className="text-primary underline"
          href={m[6]}
          target="_blank"
          rel="noreferrer noopener"
        >
          {m[6]}
        </a>,
      );
    }
    i = m.index + m[0].length;
  }
  if (i < line.length) out.push(line.slice(i));
  return out;
}

export function MarkdownContent({
  content,
  mentionMap,
}: {
  content: string;
  mentionMap: Map<string, string>;
}) {
  const blocks: React.ReactNode[] = [];
  const lines = content.split("\n");
  let buf: string[] = [];
  let codeFence: string[] | null = null;

  const flush = () => {
    if (buf.length === 0) return;
    const isQuote = buf.every((l) => l.startsWith(">"));
    const text = buf.map((l) => (isQuote ? l.replace(/^>\s?/, "") : l));
    if (isQuote) {
      blocks.push(
        <blockquote
          key={blocks.length}
          className="border-l-2 pl-3 text-sm text-muted-foreground my-1"
        >
          {text.map((l, idx) => (
            <p key={idx}>{renderInline(l, mentionMap)}</p>
          ))}
        </blockquote>,
      );
    } else {
      blocks.push(
        <p key={blocks.length} className="whitespace-pre-wrap">
          {text.flatMap((l, idx) => [
            idx > 0 ? <br key={`br-${idx}`} /> : null,
            ...renderInline(l, mentionMap),
          ])}
        </p>,
      );
    }
    buf = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (codeFence) {
        blocks.push(
          <pre
            key={blocks.length}
            className="bg-muted text-xs p-2 rounded overflow-x-auto"
          >
            <code>{codeFence.join("\n")}</code>
          </pre>,
        );
        codeFence = null;
      } else {
        flush();
        codeFence = [];
      }
      continue;
    }
    if (codeFence) {
      codeFence.push(line);
      continue;
    }
    buf.push(line);
  }
  flush();
  if (codeFence) {
    blocks.push(
      <pre
        key={blocks.length}
        className="bg-muted text-xs p-2 rounded overflow-x-auto"
      >
        <code>{codeFence.join("\n")}</code>
      </pre>,
    );
  }

  return <>{blocks}</>;
}
