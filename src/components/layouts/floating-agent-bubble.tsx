"use client";

import { useEffect } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDrawers } from "@/components/drawers/drawer-provider";

/**
 * Persistent floating COSMOS Agent affordance (item 9).
 *
 * A bottom-right bubble that opens the ONE docked Assistant drawer — the SAME
 * surface as the topbar ✨ trigger and the `cosmos:agent:open` event (mobile
 * bottom nav, command palette). Previously this hosted its OWN slide-over with
 * a different assistant component, which diverged from the topbar drawer; now
 * it's a pure entry point so the agent experience is identical everywhere.
 *
 * Rendered only when an org is in context (the drawer's panels need an orgId).
 * On mobile the bubble lifts above the bottom-nav safe area.
 */
export function FloatingAgentBubble({ orgId }: { orgId: string | undefined }) {
  const { open, isOpen } = useDrawers();

  // Let other surfaces (mobile bottom nav, command palette) open the agent.
  useEffect(() => {
    function onOpen() {
      open("assistant");
    }
    window.addEventListener("cosmos:agent:open", onOpen);
    return () => window.removeEventListener("cosmos:agent:open", onOpen);
  }, [open]);

  if (!orgId) return null;

  // Hide the bubble while the assistant drawer is already open (its own header
  // has the close control) so they don't overlap.
  if (isOpen("assistant")) return null;

  return (
    <button
      type="button"
      onClick={() => open("assistant")}
      aria-label="Open COSMOS Agent"
      title="COSMOS Agent"
      className={cn(
        "fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-40 md:bottom-6 md:right-6",
        "flex h-12 w-12 items-center justify-center rounded-full",
        "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-lg",
        "transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
      )}
    >
      <Sparkles className="h-5 w-5" />
    </button>
  );
}
