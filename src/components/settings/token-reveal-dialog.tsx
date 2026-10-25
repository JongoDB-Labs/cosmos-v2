"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The one time a freshly minted secret is shown. Closing it clears the secret
 * from the caller's state (`onClose`), so it doesn't linger after the dialog.
 */
export function TokenRevealDialog({
  token,
  title,
  onClose,
}: {
  /** Open while non-empty. */
  token: string;
  title: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyToken() {
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={token !== ""} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Copy this now — it will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 py-2">
          <code className="flex-1 break-all rounded-md border border-[var(--border)] bg-[var(--bg-muted,var(--surface))] px-3 py-2 font-mono text-xs">
            {token}
          </code>
          <Button
            variant="outline"
            size="icon"
            onClick={copyToken}
            aria-label={copied ? "Copied" : "Copy API token"}
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
