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
import { displayUrl, isBareUrlLabel } from "@/lib/format/display-url";

/**
 * Render a small markdown subset to React elements. Supports:
 *   - entity mention tokens: `<@uuid>` (person) and `<@type:id>` (any entity),
 *     resolved via `refMap` and rendered as a deep-link chip when the entity
 *     has a URL, otherwise a plain label chip
 *   - `**bold**`, `*italic*`, `~strike~`
 *   - `inline code` and ```fenced code blocks```
 *   - > quoted lines
 *   - markdown links `[label](https://...)` — which the Lexical editor emits
 *     for anything it auto-linked, so this is the shape a PASTED url arrives in
 *   - autolinks (https://...), rendered with a shortened label
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

/**
 * Trim the punctuation a URL picks up from the prose around it.
 *
 * `(see https://x.com/a)` and `https://x.com/a.` both autolink one character too
 * far. A trailing `)` is only sentence punctuation when the URL has no unclosed
 * `(` of its own — otherwise it belongs to the link
 * (`.../wiki/Foo_(bar)`), which is the same balance rule CommonMark's autolink
 * extension uses.
 *
 * Returns the URL and whatever was trimmed, so the caller can render the
 * trimmed characters back as plain text instead of eating them.
 */
export function splitTrailingPunctuation(url: string): [string, string] {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (".,;:!?'\"".includes(ch)) {
      end--;
      continue;
    }
    if (ch === ")") {
      const slice = url.slice(0, end);
      const opens = (slice.match(/\(/g) ?? []).length;
      const closes = (slice.match(/\)/g) ?? []).length;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return [url.slice(0, end), url.slice(end)];
}

function ExternalLink({
  href,
  label,
  keyPrefix,
}: {
  href: string;
  label: string;
  keyPrefix: string;
}) {
  return (
    <a
      key={keyPrefix}
      className="text-primary underline break-words"
      href={href}
      // The label is deliberately shortened, so the full target has to stay
      // reachable somewhere the reader can get at it without clicking.
      title={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {label}
    </a>
  );
}

// Exported so other renderers can reuse the exact same inline tokenizer.
export function renderInline(line: string, refMap: RefMap): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  // The `[label](url)` alternative MUST precede the bare-url one: at the `[` the
  // engine tries alternatives in order, and without it the url inside the
  // parentheses would autolink on its own and the brackets would render as
  // literal text — which is the reported "shows the whole url" symptom.
  const re =
    /<@(?:([a-zA-Z][a-zA-Z0-9]*):)?([a-zA-Z0-9_-]+)>|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~[^~]+~)|\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|((?:https?:\/\/[^\s]+))/gi;
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
    } else if (m[8]) {
      // `[label](url)`. A label the editor generated from the url itself gets
      // the shortened form; a label a PERSON wrote is theirs and is left alone.
      const href = m[8];
      const written = m[7] ?? "";
      const label =
        written.trim() === "" || isBareUrlLabel(written, href)
          ? displayUrl(href)
          : written;
      out.push(<ExternalLink key={`${m.index}-a`} keyPrefix={`${m.index}-a`} href={href} label={label} />);
    } else if (m[9]) {
      const [href, trailing] = splitTrailingPunctuation(m[9]);
      if (href) {
        out.push(
          <ExternalLink key={`${m.index}-a`} keyPrefix={`${m.index}-a`} href={href} label={displayUrl(href)} />,
        );
        if (trailing) out.push(trailing);
      } else {
        out.push(m[9]);
      }
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
