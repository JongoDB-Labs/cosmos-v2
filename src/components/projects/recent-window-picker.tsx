"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { RECENT_WINDOWS, type RecentWindowKey } from "@/lib/projects/recent";

/**
 * How far back "Recent projects" looks.
 *
 * The choice lives in the URL (`?recent=`), so it survives a reload, can be
 * bookmarked, and needs no schema column — `UserPreferences` is a wide typed
 * model, and a migration is a lot to carry for one window.
 */
export function RecentWindowPicker({ current }: { current: RecentWindowKey }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function choose(key: RecentWindowKey) {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    next.set("recent", key);
    router.replace(`?${next.toString()}`, { scroll: false });
  }

  return (
    <div
      role="group"
      aria-label="How far back to look"
      className="flex items-center gap-1"
    >
      {RECENT_WINDOWS.map((w) => (
        <button
          key={w.key}
          type="button"
          onClick={() => choose(w.key)}
          aria-pressed={w.key === current}
          className={
            w.key === current
              ? "rounded-md bg-[var(--primary)] px-2 py-1 text-xs font-medium text-[var(--primary-foreground)]"
              : "rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          }
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}
