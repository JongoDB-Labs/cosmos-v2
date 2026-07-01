"use client";
import React from "react";
import Link from "next/link";
import {
  ENTITY_LABEL,
  isEntityType,
  refKey,
  type EntityType,
  type ResolvedEntity,
} from "@/lib/mentions/refs";
import { ENTITY_PREFIX } from "@/lib/mentions/registry.client";

/**
 * Render a small markdown subset to React elements. Supports:
 *   - entity mention tokens: `<@uuid>` (person) and `<@type:id>` (any entity),
 *     resolved via `refMap` and rendered as a deep-link chip when the entity
 *     has a URL, otherwise a plain label chip
 *   - `**bold**`, `*italic*`, `~strike~`
 *   - `inline code` and ```fenced code blocks```
 *   - > quoted lines
 *   - autolinks (https://...)
 *   - line breaks
 *
 * NO HTML output. Tokens render as React elements directly.
 * NO dangerouslySetInnerHTML.
 */

/** A resolved-reference map keyed by `refKey(type, id)`. */
export type RefMap = Map<string, ResolvedEntity>;

function MentionChip({
  type,
  id,
  refMap,
  keyPrefix,
}: {
  type: EntityType;
  id: string;
  refMap: RefMap;
  keyPrefix: string;
}) {
  const resolved = refMap.get(refKey(type, id));
  const label = resolved?.label ?? (type === "user" ? "user" : ENTITY_LABEL[type]);
  const text = `${ENTITY_PREFIX[type]}${label}`;
  const cls = "inline rounded bg-accent px-1 text-xs font-medium";
  if (resolved?.url) {
    return (
      <Link key={keyPrefix} href={resolved.url} className={`${cls} hover:underline`}>
        {text}
      </Link>
    );
  }
  return (
    <span key={keyPrefix} className={cls}>
      {text}
    </span>
  );
}

// Exported so other renderers can reuse the exact same inline tokenizer.
export function renderInline(line: string, refMap: RefMap): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  const re =
    /<@(?:([a-zA-Z][a-zA-Z0-9]*):)?([a-zA-Z0-9_-]+)>|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~[^~]+~)|((?:https?:\/\/[^\s]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > i) out.push(line.slice(i, m.index));
    if (m[2] !== undefined) {
      const type: EntityType = isEntityType(m[1]) ? m[1] : "user";
      out.push(
        <MentionChip
          key={`${m.index}-mention`}
          keyPrefix={`${m.index}-mention`}
          type={type}
          id={m[2]}
          refMap={refMap}
        />,
      );
    } else if (m[3]) {
      out.push(
        <code key={`${m.index}-code`} className="px-1 rounded bg-muted text-xs">
          {m[3].slice(1, -1)}
        </code>,
      );
    } else if (m[4]) {
      out.push(<strong key={`${m.index}-b`}>{m[4].slice(2, -2)}</strong>);
    } else if (m[5]) {
      out.push(<em key={`${m.index}-i`}>{m[5].slice(1, -1)}</em>);
    } else if (m[6]) {
      out.push(<s key={`${m.index}-s`}>{m[6].slice(1, -1)}</s>);
    } else if (m[7]) {
      out.push(
        <a
          key={`${m.index}-a`}
          className="text-primary underline"
          href={m[7]}
          target="_blank"
          rel="noreferrer noopener"
        >
          {m[7]}
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
  refMap,
}: {
  content: string;
  refMap: RefMap;
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
            <p key={idx}>{renderInline(l, refMap)}</p>
          ))}
        </blockquote>,
      );
    } else {
      blocks.push(
        <p key={blocks.length} className="whitespace-pre-wrap">
          {text.flatMap((l, idx) => [
            idx > 0 ? <br key={`br-${idx}`} /> : null,
            ...renderInline(l, refMap),
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
