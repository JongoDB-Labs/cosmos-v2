"use client";

import * as React from "react";
import { Combobox } from "@base-ui/react/combobox";
import { ChevronDownIcon, CheckIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SearchableOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * A single-select dropdown with a built-in filter input — the searchable
 * counterpart to the shared <Select>. Built on base-ui's Combobox (NOT Select)
 * because Select owns its popup's keyboard typeahead and won't tolerate a
 * focusable filter input inside the popup. Drop-in for the very common
 * `options.map(o => <SelectItem value={o.id}>{label}</SelectItem>)` pattern when
 * the list is long enough to warrant filtering (members, accounts, projects…).
 *
 * API mirrors <Select>'s controlled shape: a string `value` in, a
 * `(string | null)` out — so call sites don't have to juggle base-ui's object
 * item values. Filtering is automatic: base-ui matches the input text against
 * each item's `label` (inferred from the `{ value, label }` shape).
 */
export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches",
  size = "default",
  className,
  contentClassName,
  disabled,
  id,
  name,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedby,
  "aria-required": ariaRequired,
}: {
  value: string | null | undefined;
  onValueChange: (value: string | null) => void;
  options: SearchableOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  size?: "sm" | "default";
  /** Classes for the trigger button (width, etc.) — matches <SelectTrigger>. */
  className?: string;
  /** Classes for the popup container. */
  contentClassName?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  // Accessibility passthrough so this composes inside <FormField> (which spreads
  // id + these aria attributes onto its control).
  "aria-invalid"?: boolean | "true" | "false";
  "aria-describedby"?: string;
  "aria-required"?: boolean | "true" | "false";
}) {
  // Control by the matching option object so base-ui's referential equality
  // (Object.is) lines up with the rendered items, and map back to the string id
  // at the boundary so call sites stay string-in / string-out.
  const selected = React.useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  return (
    <Combobox.Root
      items={options}
      value={selected}
      onValueChange={(next: SearchableOption | null) =>
        onValueChange(next ? next.value : null)
      }
      disabled={disabled}
      name={name}
    >
      <Combobox.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedby}
        aria-required={ariaRequired}
        data-size={size}
        className={cn(
          "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className,
        )}
      >
        <Combobox.Value placeholder={placeholder}>
          {(v: SearchableOption | null) =>
            v ? (
              <span className="line-clamp-1 flex-1 text-left">{v.label}</span>
            ) : (
              <span className="line-clamp-1 flex-1 text-left text-muted-foreground">
                {placeholder}
              </span>
            )
          }
        </Combobox.Value>
        <Combobox.Icon
          render={
            <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
          }
        />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} className="isolate z-50">
          <Combobox.Popup
            className={cn(
              "relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-[12rem] origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              contentClassName,
            )}
          >
            <div className="relative border-b border-border p-1.5">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Combobox.Input
                placeholder={searchPlaceholder}
                className="h-8 w-full rounded-md bg-transparent pr-2 pl-7 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Combobox.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
              {emptyText}
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(18rem,var(--available-height))] overflow-y-auto p-1">
              {(item: SearchableOption) => (
                <Combobox.Item
                  key={item.value}
                  value={item}
                  disabled={item.disabled}
                  className="relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <span className="line-clamp-1 flex-1">{item.label}</span>
                  <Combobox.ItemIndicator
                    render={
                      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
                    }
                  >
                    <CheckIcon className="size-4" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
