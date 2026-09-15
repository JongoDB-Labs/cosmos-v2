"use client";

import { useEffect, useRef, useState } from "react";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PluginRegistry } from "@/lib/plugins/registry";
import { useEnabledPlugins } from "@/components/plugins/plugin-slot";
import { usePermissions } from "@/components/providers/permissions-provider";
import { availableTours } from "@/lib/tours/registry";
import { TourLauncher } from "./tour-launcher";

/**
 * Topbar entry to the walkthroughs.
 *
 * Hidden entirely when there are none, so a deployment that has never been
 * given one sees no button — the mechanism ships to everybody, the content does
 * not, and an empty menu is worse than no menu.
 */
export function TourMenu() {
  const enabled = useEnabledPlugins();
  const { permissions } = usePermissions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (availableTours(PluginRegistry.getAll(), enabled, permissions).length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-[var(--text-muted)] hover:text-[var(--text)]"
        onClick={() => setOpen((o) => !o)}
        aria-label="Walkthroughs"
        aria-expanded={open}
        title="Walkthroughs"
      >
        <Compass className="h-4 w-4" />
      </Button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg">
          <TourLauncher onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
