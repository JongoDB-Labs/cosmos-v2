"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Search, X, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  parseJql,
  suggestJql,
  type ParsedJql,
  type QueryVocab,
  type Suggestion,
} from "@/lib/work-items/query/jql";

/**
 * A Jira-like query bar (COSMOS-59): type free keywords AND field-scoped
 * clauses (`project = FSC`, `priority is high`, `label = urgent`) in one box.
 * Offers autocomplete for fields/operators/values as you type, surfaces parse
 * errors inline, and hands the parsed {@link ParsedJql} to `onApply` on submit.
 *
 * Controlled: the raw query string lives in the parent (so a "Clear" or an
 * applied saved view can reset it). The parser + suggester are pure — this
 * component is only keyboard + presentation.
 */
export interface QueryBarProps {
  value: string;
  onValueChange: (value: string) => void;
  vocab: QueryVocab;
  onApply: (parsed: ParsedJql) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}

export function QueryBar({
  value,
  onValueChange,
  vocab,
  onApply,
  placeholder = "Query — e.g. project = FSC priority = high overdue",
  className,
  ariaLabel = "Search and filter issues",
}: QueryBarProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const parsed = useMemo(() => parseJql(value, vocab), [value, vocab]);
  const suggestions = useMemo(() => suggestJql(value, vocab), [value, vocab]);

  // Errors are noise while the autocomplete is actively helping — only surface
  // them once the box is blurred or there's nothing left to suggest.
  const showErrors =
    value.trim().length > 0 &&
    parsed.errors.length > 0 &&
    (!open || suggestions.length === 0);

  const showList = open && suggestions.length > 0;

  function accept(suggestion: Suggestion) {
    onValueChange(suggestion.newInput);
    setActiveIndex(-1);
    setOpen(true);
    inputRef.current?.focus();
  }

  function apply() {
    setOpen(false);
    setActiveIndex(-1);
    onApply(parseJql(value, vocab));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && showList) {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => {
        const n = suggestions.length;
        if (e.key === "ArrowDown") return i + 1 >= n ? 0 : i + 1;
        return i - 1 < 0 ? n - 1 : i - 1;
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (showList && activeIndex >= 0 && suggestions[activeIndex]) {
        accept(suggestions[activeIndex]);
      } else {
        apply();
      }
      return;
    }
    if (e.key === "Tab" && showList && activeIndex >= 0) {
      // Tab completes an explicitly-highlighted suggestion without leaving. With
      // no active row, Tab flows normally (blur applies + moves focus on).
      e.preventDefault();
      accept(suggestions[activeIndex]);
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  function clear() {
    onValueChange("");
    setActiveIndex(-1);
    onApply(parseJql("", vocab));
    inputRef.current?.focus();
  }

  return (
    <div className={cn("relative min-w-[240px] flex-1", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-[0.5625rem] h-4 w-4 text-[var(--text-muted)]" />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Leaving the box runs the query (mirrors the old search-on-blur).
          // Suggestion + clear buttons preventDefault their mousedown, so they
          // never blur the input — only a genuine focus-leave reaches here.
          setOpen(false);
          setActiveIndex(-1);
          onApply(parseJql(value, vocab));
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "h-8 w-full rounded-lg border bg-transparent pl-8 pr-8 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
          showErrors
            ? "border-destructive focus-visible:border-destructive"
            : "border-input focus-visible:border-ring",
        )}
      />
      {value.length > 0 && (
        <button
          type="button"
          aria-label="Clear query"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--muted)]/50 hover:text-[var(--text)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-9 z-20 max-h-72 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
        >
          {suggestions.map((s, idx) => (
            <li key={`${s.kind}-${s.label}-${idx}`} role="option" aria-selected={idx === activeIndex}>
              <button
                type="button"
                // mousedown fires before blur — preventDefault keeps focus so
                // accepting a suggestion doesn't collapse the list first.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => accept(s)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm",
                  idx === activeIndex ? "bg-[var(--muted)]/60" : "hover:bg-[var(--muted)]/40",
                )}
              >
                <span className="truncate text-[var(--text)]">{s.label}</span>
                {s.hint && (
                  <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{s.hint}</span>
                )}
              </button>
            </li>
          ))}
          <li className="border-t border-[var(--border)] px-3 py-1 text-[11px] text-[var(--text-muted)]">
            ↑↓ to navigate · Tab to complete · Enter to search
          </li>
        </ul>
      )}

      {showErrors && (
        <p
          role="status"
          aria-live="polite"
          className="absolute left-0 right-0 top-9 z-10 flex items-center gap-1.5 rounded-b-lg bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--status-critical,#dc2626)]"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {parsed.errors[0].message}
            {parsed.errors.length > 1 ? ` (+${parsed.errors.length - 1} more)` : ""}
          </span>
        </p>
      )}
    </div>
  );
}
