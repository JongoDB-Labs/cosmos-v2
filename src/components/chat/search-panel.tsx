"use client";
import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useChatSearch } from "@/hooks/use-chat-search";
import { LoadError } from "@/components/ui/load-error";
import { Search, X } from "lucide-react";

/**
 * Allow ONLY <b>…</b> tags from postgres `ts_headline`. Everything else
 * (other tags, attributes, scripts, weird quoted constructs) is stripped.
 * The headline excerpt is content the user authored; even so, treating it
 * as plain text with controlled markup keeps the XSS surface flat.
 */
function sanitizeHeadline(s: string): string {
  // Replace any tag that is not exactly <b> or </b> with empty string.
  return s.replace(/<(?!\/?b\s*>)[^>]*>/gi, "");
}

const OPERATOR_RE = /^(from|in|has|before|after):(.+)$/i;

/** Parse recognized `key:value` operators out of the query for display as
 *  removable chips. Mirrors the server's parser (search/route.ts). */
function parseChips(q: string): { key: string; value: string; token: string }[] {
  const chips: { key: string; value: string; token: string }[] = [];
  for (const tok of q.trim().split(/\s+/)) {
    const m = tok.match(OPERATOR_RE);
    if (m) chips.push({ key: m[1].toLowerCase(), value: m[2], token: tok });
  }
  return chips;
}

export function SearchPanel({ orgId }: { orgId: string }) {
  const [q, setQ] = useState("");
  const { data, isLoading, isError, refetch } = useChatSearch(orgId, q);
  const router = useRouter();
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1] ?? "";

  const chips = parseChips(q);
  const removeToken = (token: string) =>
    setQ(
      q
        .trim()
        .split(/\s+/)
        .filter((t) => t !== token)
        .join(" "),
    );

  return (
    <div className="px-2 py-2">
      <div className="flex items-center gap-1 border rounded px-2 py-1">
        <Search className="h-3 w-3 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search · try from: in: has:link before:"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="flex-1 bg-transparent text-xs focus:outline-none"
          aria-label="Search messages"
        />
      </div>
      {chips.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {chips.map((chip) => (
            <span
              key={chip.token}
              className="inline-flex items-center gap-0.5 rounded bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground"
            >
              <span className="font-medium">{chip.key}:</span>
              {chip.value}
              <button
                type="button"
                onClick={() => removeToken(chip.token)}
                aria-label={`Remove ${chip.key} filter`}
                className="ml-0.5 rounded hover:bg-background/50"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      {q.length >= 2 && (
        <div className="mt-2 max-h-72 overflow-y-auto border rounded">
          {isError && (
            <div className="p-2">
              <LoadError
                onRetry={() => {
                  refetch();
                }}
              />
            </div>
          )}
          {!isError && isLoading && (
            <div className="text-xs text-muted-foreground p-2">Searching…</div>
          )}
          {!isError && !isLoading && (data?.length ?? 0) === 0 && (
            <div className="text-xs text-muted-foreground p-2">No matches</div>
          )}
          {data?.map((h) => (
            <button
              key={h.messageId}
              type="button"
              onClick={() =>
                router.push(`/${orgSlug}/chat/${h.channelId}#msg-${h.messageId}`)
              }
              className="w-full text-left px-2 py-1.5 hover:bg-accent border-t first:border-t-0"
            >
              <div className="text-[10px] text-muted-foreground">
                {h.channelKind === "CHANNEL"
                  ? `#${h.channelName ?? "channel"}`
                  : "DM"}
              </div>
              <div
                className="text-xs"
                dangerouslySetInnerHTML={{ __html: sanitizeHeadline(h.snippet) }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
