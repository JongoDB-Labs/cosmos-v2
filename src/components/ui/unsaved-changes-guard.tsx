"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface UnsavedChangesGuardProps {
  dirty: boolean;
  onSave: () => Promise<boolean>;
  onDiscard: () => void;
}

export function UnsavedChangesGuard({
  dirty,
  onSave,
  onDiscard,
}: UnsavedChangesGuardProps) {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(dirty);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    function beforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!dirtyRef.current) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (anchor.target === "_blank") return;
      if (e.defaultPrevented) return;

      try {
        const url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin) return;
        if (url.pathname === window.location.pathname) return;
        e.preventDefault();
        setPendingHref(url.pathname + url.search + url.hash);
      } catch {
        // bad URL, let it through
      }
    }
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  async function handleSaveAndNavigate() {
    setSaving(true);
    try {
      const ok = await onSave();
      if (ok && pendingHref) {
        router.push(pendingHref);
        setPendingHref(null);
      }
    } finally {
      setSaving(false);
    }
  }

  function handleDiscardAndNavigate() {
    onDiscard();
    if (pendingHref) {
      router.push(pendingHref);
      setPendingHref(null);
    }
  }

  return (
    <Dialog open={!!pendingHref} onOpenChange={(open) => !open && setPendingHref(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save changes?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          You have unsaved changes. Would you like to save them before leaving?
        </p>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => setPendingHref(null)} disabled={saving}>
            Stay
          </Button>
          <Button variant="outline" onClick={handleDiscardAndNavigate} disabled={saving}>
            Discard
          </Button>
          <Button onClick={handleSaveAndNavigate} disabled={saving}>
            {saving ? "Saving..." : "Save & leave"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
