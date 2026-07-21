"use client";
import { useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface TabDef {
  id: string;
  label: string;
}

/** Active tab is derived from the URL ?tab= param (single source of truth), so tabs
 *  are deep-linkable + back-button friendly. Setter uses router.replace (no history
 *  spam, no scroll jump). Unknown/absent param falls back to defaultId. */
export function useTabParam(defaultId: string, validIds: string[]): [string, (id: string) => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = sp.get("tab");
  const active = raw && validIds.includes(raw) ? raw : defaultId;
  const setActive = useCallback(
    (id: string) => {
      const p = new URLSearchParams(sp.toString());
      p.set("tab", id);
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    },
    [sp, router, pathname],
  );
  return [active, setActive];
}

/** Accessible tab strip. Presentational — the parent owns active state + panels. */
export function TabList({ tabs, active, onSelect }: { tabs: TabDef[]; active: string; onSelect: (id: string) => void }) {
  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = (idx + delta + tabs.length) % tabs.length;
    onSelect(tabs[next].id);
  };
  return (
    <div role="tablist" className="flex gap-1 border-b border-[var(--border)]">
      {tabs.map((t, i) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`tabpanel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              selected
                ? "border-[var(--primary)] text-[var(--text)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
