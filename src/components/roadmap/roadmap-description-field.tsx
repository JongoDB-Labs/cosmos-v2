"use client";

import { useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Textarea } from "@/components/ui/textarea";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { cn } from "@/lib/utils";
import { RoadmapMarkdown } from "./roadmap-markdown";

interface PickerNode {
  id: string;
  kind: string;
  externalRef: string | null;
  anchor: string;
  title: string;
}

/**
 * Description editor with a Write/Preview toggle (so Markdown — incl. roadmap
 * deep-links — renders clickable) and a `#`-triggered roadmap-node picker that
 * inserts a deep-link to a phase/risk/decision. Drop-in replacement for the
 * plain description Textarea; derives orgSlug/projectKey from the URL.
 */
export function RoadmapDescriptionField({
  value,
  onChange,
  orgId,
  projectId,
  resetKey,
  placeholder = "Add a description… (type # to link a roadmap node)",
}: {
  value: string;
  onChange: (next: string) => void;
  orgId: string;
  projectId: string;
  /** Changes (e.g. the work-item id) reset the Write/Preview mode for a new item. */
  resetKey?: string;
  placeholder?: string;
}) {
  const pathname = usePathname();
  const parts = pathname.split("/").filter(Boolean);
  const orgSlug = parts[0] ?? "";
  const projectKey = parts[1] === "projects" ? parts[2] ?? "" : "";

  const [mode, setMode] = useState<"write" | "preview">(
    value.trim() ? "preview" : "write",
  );
  const [trigger, setTrigger] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Reset Write/Preview when a different item loads (keyed on the item id), using
  // the render-time "adjust state on prop change" pattern — NOT an effect, so it
  // doesn't fire on every keystroke and keeps the user in Write while editing.
  const [prevKey, setPrevKey] = useState(resetKey);
  if (resetKey !== prevKey) {
    setPrevKey(resetKey);
    setMode(value.trim() ? "preview" : "write");
    setTrigger(null);
  }

  const nodesKey = useOrgQueryKey("roadmap-nodes", projectId);
  const { data: nodes } = useQuery({
    queryKey: nodesKey,
    queryFn: () =>
      jsonFetch<PickerNode[]>(`/api/v1/orgs/${orgId}/projects/${projectId}/roadmap-nodes`),
    enabled: trigger !== null,
    staleTime: 60_000,
  });

  const matches = useMemo(() => {
    if (trigger === null) return [];
    const q = trigger.toLowerCase();
    return (nodes ?? [])
      .filter(
        (n) =>
          !q ||
          (n.externalRef ?? "").toLowerCase().includes(q) ||
          n.title.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [nodes, trigger]);

  function detectTrigger() {
    const ta = ref.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)#([A-Za-z0-9-]*)$/);
    setTrigger(m ? m[1] : null);
    setHighlight(0);
  }

  function insert(node: PickerNode) {
    const ta = ref.current;
    const caret = ta?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const label = node.externalRef ?? node.title;
    const href = `/${orgSlug}/projects/${projectKey}/roadmap/${node.anchor}`;
    const newBefore = before.replace(
      /(^|\s)#([A-Za-z0-9-]*)$/,
      (_m, p1) => `${p1}[${label}](${href}) `,
    );
    onChange(newBefore + after);
    setTrigger(null);
    requestAnimationFrame(() => {
      ta?.focus();
      const pos = newBefore.length;
      ta?.setSelectionRange(pos, pos);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (trigger === null || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insert(matches[highlight]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setTrigger(null);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 text-xs">
        {(["write", "preview"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "rounded px-2 py-0.5 capitalize transition-colors",
              mode === m
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "write" ? (
        <div className="relative">
          <Textarea
            ref={ref}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              detectTrigger();
            }}
            onKeyDown={onKeyDown}
            onClick={detectTrigger}
            onBlur={() => setTimeout(() => setTrigger(null), 120)}
            placeholder={placeholder}
            className="min-h-20 resize-none"
          />
          {trigger !== null && matches.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
              {matches.map((n, i) => (
                <button
                  key={n.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insert(n);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                    i === highlight ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {n.externalRef ?? n.kind}
                  </span>
                  <span className="truncate text-foreground">{n.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : value.trim() ? (
        <button
          type="button"
          onClick={() => setMode("write")}
          className="block w-full rounded-md border bg-background p-3 text-left transition-colors hover:border-primary/40"
          title="Click to edit"
        >
          <RoadmapMarkdown>{value}</RoadmapMarkdown>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setMode("write")}
          className="w-full rounded-md border border-dashed p-3 text-left text-sm text-muted-foreground hover:text-foreground"
        >
          {placeholder}
        </button>
      )}
    </div>
  );
}
