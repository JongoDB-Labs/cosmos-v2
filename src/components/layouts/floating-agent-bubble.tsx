"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { AssistantPanel } from "@/components/assistant/assistant-panel";

/**
 * Persistent floating COSMOS Agent affordance (item 9).
 *
 * Replaces the old "/assistant" sidebar entry. A bottom-right bubble (the
 * STAR/sparkle mark used elsewhere in the nav) opens a slide-over hosting the
 * existing AssistantPanel — the agent experience is unchanged, only its entry
 * point moved to a floating overlay.
 *
 * Rendered only when an org is in context (the panel needs an orgId). On
 * mobile the bottom bar already exposes the agent, so the bubble lifts above
 * the bottom-nav safe area.
 */
export function FloatingAgentBubble({ orgId }: { orgId: string | undefined }) {
  const [open, setOpen] = useState(false);

  // Let other surfaces (mobile bottom nav, command palette) open the agent.
  useEffect(() => {
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("cosmos:agent:open", onOpen);
    return () => window.removeEventListener("cosmos:agent:open", onOpen);
  }, []);

  if (!orgId) return null;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
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
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="flex w-full flex-col p-0 sm:max-w-xl"
        >
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-[var(--primary)]" />
              COSMOS Agent
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close COSMOS Agent"
              className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <AssistantPanel orgId={orgId} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
