"use client";

import { Sparkles, Settings, X } from "lucide-react";
import Link from "next/link";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { AssistantPanel } from "@/components/assistant/assistant-panel";
import { useDrawers } from "./drawer-provider";

interface AssistantDrawerProps {
  orgId: string;
  orgSlug: string;
}

/**
 * Global slide-over for the streaming assistant chat. REUSES the existing
 * {@link AssistantPanel}, which already owns the full conversation /
 * SSE-streaming experience against
 * `POST /api/v1/orgs/[orgId]/assistant/conversations[/[id]/messages]`.
 *
 * The header carries a settings affordance that deep-links to the provider
 * selector (`/[orgSlug]/settings/ai`) — provider configuration is NOT rebuilt
 * here, only linked.
 */
export function AssistantDrawer({ orgId, orgSlug }: AssistantDrawerProps) {
  const { isOpen, close } = useDrawers();

  return (
    <Sheet open={isOpen("assistant")} onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col p-0 sm:max-w-[460px]"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-[var(--primary)]" />
            Assistant
          </span>
          <div className="flex items-center gap-1">
            <Link
              href={`/${orgSlug}/settings/ai`}
              onClick={() => close()}
              aria-label="AI provider settings"
              title="AI provider settings"
              className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
            >
              <Settings className="h-4 w-4" />
            </Link>
            <button
              type="button"
              onClick={() => close()}
              aria-label="Close assistant"
              className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <AssistantPanel orgId={orgId} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
