"use client";

import { useEffect } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDrawers } from "@/components/drawers/drawer-provider";
import { focusDrawerTab } from "@/components/drawers/drawer-tab";
import { useBrand } from "@/components/providers/brand-provider";
import { Z_ASSISTANT } from "@/lib/ui/layers";

/**
 * Bottom room the page keeps free while the corner button is shown: 24px edge
 * gap + 48px button + 12px for the attached minimize control + 4px.
 */
export const LAUNCHER_CLEAR = "88px";
/**
 * The same for full-screen views on phones, measured from the viewport bottom:
 * the button's offset (above where the bottom nav sits) + 48px button + 4px.
 */
export const LAUNCHER_CLEAR_MOBILE = "calc(5.25rem + env(safe-area-inset-bottom) + 52px)";

/**
 * The corner button that opens the ONE docked assistant drawer — the same
 * surface as the topbar trigger and the `cosmos:agent:open` event (mobile
 * bottom nav, command palette, wake word; that listener lives in DockedDrawer,
 * which is always mounted).
 *
 * It sits in ONE place: bottom-right, above the bottom nav on phones. It does
 * not move out of the way of what is under it. Instead the page keeps room for
 * it — it publishes `--cosmos-launcher-clear` (and a phone variant for
 * full-screen views), which the shell adds to `<main>`'s bottom padding and
 * fixed page bars add to their right inset — and the attached control puts the
 * assistant aside to the side tab, freeing the corner entirely.
 *
 * Hidden while any drawer is open or minimized, and when no org is in context.
 */
export function FloatingAgentBubble({ orgId }: { orgId: string | undefined }) {
  const { open, minimize, tool } = useDrawers();
  const brand = useBrand();

  const hidden = !orgId || tool !== null;

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--cosmos-launcher-clear", hidden ? "0px" : LAUNCHER_CLEAR);
    root.style.setProperty(
      "--cosmos-launcher-clear-mobile",
      hidden ? "0px" : LAUNCHER_CLEAR_MOBILE,
    );
    return () => {
      root.style.setProperty("--cosmos-launcher-clear", "0px");
      root.style.setProperty("--cosmos-launcher-clear-mobile", "0px");
    };
  }, [hidden]);

  if (hidden) return null;

  return (
    <div
      className={cn(
        "fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-4 h-12 w-12 md:bottom-6 md:right-6",
        Z_ASSISTANT,
      )}
    >
      <button
        type="button"
        onClick={() => open("assistant")}
        aria-label={`Open ${brand.agentName}`}
        title={brand.agentName}
        className={cn(
          "flex h-12 w-12 items-center justify-center rounded-full",
          "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-lg",
          "transition-[scale] duration-200 motion-reduce:transition-none hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
        )}
      >
        <Sparkles className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={() => {
          minimize();
          focusDrawerTab();
        }}
        aria-label={`Minimize ${brand.agentName} to the side`}
        title={`Minimize ${brand.agentName} to the side`}
        // 24x24 (WCAG 2.5.8 minimum target), centred on the button's left edge.
        className="absolute -left-3 top-3 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] shadow-sm hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
