"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, ArrowUpCircle, Bug } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CHANGELOG,
  CURRENT_VERSION,
  releasesSince,
  type Release,
  type ChangeKind,
} from "@/lib/changelog";

const SEEN_KEY = "cosmos:whatsNewSeen";

const KIND_META: Record<
  ChangeKind,
  { label: string; color: string; Icon: React.ComponentType<{ className?: string; color?: string }> }
> = {
  feature: { label: "New", color: "var(--primary)", Icon: Sparkles },
  improvement: { label: "Improved", color: "var(--status-progress)", Icon: ArrowUpCircle },
  fix: { label: "Fixed", color: "var(--status-done)", Icon: Bug },
};

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * "What's new" modal (FR: catch users up on new features/fixes when a version
 * ships). Auto-opens ONCE per new version — it compares the running version to
 * the last one this browser acknowledged (localStorage) and lists only what's
 * newer. The sidebar's "What's new" menu item re-opens it with the full history
 * via the `cosmos:open-whats-new` event. Renders nothing until it has something
 * to show, so it's inert on the server and for up-to-date users.
 */
export function WhatsNew() {
  const [open, setOpen] = useState(false);
  const [releases, setReleases] = useState<Release[]>([]);

  // Mount-time sync from an external system (localStorage) — the canonical
  // reason an effect may set state; the version is known only on the client.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let lastSeen: string | null = null;
    try {
      lastSeen = localStorage.getItem(SEEN_KEY);
    } catch {
      /* private mode / disabled storage — just don't auto-open */
    }
    const fresh = releasesSince(lastSeen);
    // Skip the AUTO-open under browser automation (Playwright et al. set
    // navigator.webdriver=true; real users are always false). The modal's
    // full-screen backdrop otherwise intercepts pointer events and hangs any
    // e2e spec that clicks through the page (chat channel selection, etc.).
    // The explicit "What's new" menu trigger (cosmos:open-whats-new) still works.
    if (
      !navigator.webdriver &&
      fresh.length > 0 &&
      lastSeen !== CURRENT_VERSION
    ) {
      setReleases(fresh);
      setOpen(true);
    }

    const onOpen = () => {
      setReleases(CHANGELOG.slice(0, 12));
      setOpen(true);
    };
    window.addEventListener("cosmos:open-whats-new", onOpen);
    return () => window.removeEventListener("cosmos:open-whats-new", onOpen);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // Mark the running version acknowledged so it won't auto-open again.
      try {
        localStorage.setItem(SEEN_KEY, CURRENT_VERSION);
      } catch {
        /* ignore */
      }
    }
  }

  const gotItRef = useRef<HTMLButtonElement>(null);

  if (releases.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg" initialFocus={gotItRef}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-[var(--primary)]" /> What&apos;s new
          </DialogTitle>
          <DialogDescription>
            The latest features and fixes — you&apos;re on v{CURRENT_VERSION}.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-6 overflow-y-auto pr-1" tabIndex={0} role="region" aria-label="Release notes">
          {releases.map((r) => (
            <div key={r.version}>
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-[var(--text)]">{r.title}</h3>
                <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                  v{r.version} · {formatDate(r.date)}
                </span>
              </div>
              <ul className="mt-2 space-y-2">
                {r.highlights.map((h, i) => {
                  const m = KIND_META[h.kind];
                  return (
                    <li key={i} className="flex gap-2 text-sm">
                      <span
                        className="mt-0.5 inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium"
                        style={{
                          color: "var(--text)",
                          backgroundColor: `color-mix(in srgb, ${m.color} 14%, transparent)`,
                        }}
                      >
                        <m.Icon className="size-3" color={m.color} />
                        {m.label}
                      </span>
                      <span className="text-[var(--text-muted)]">{h.text}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button ref={gotItRef} onClick={() => handleOpenChange(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
