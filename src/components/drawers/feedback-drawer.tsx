"use client";

import { useState } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { notifyError } from "@/lib/errors/notify";
import { useDrawers } from "./drawer-provider";

type FType = "BUG" | "FEATURE";

interface FeedbackDrawerProps {
  orgId: string;
}

/**
 * Global slide-over for filing feedback without leaving the current screen.
 * POSTs to the existing feedback API (`POST /api/v1/orgs/[orgId]/feedback`),
 * whose schema is `{ type, title, description }`.
 *
 * Note: the feedback API has no attachment/screenshot field, so this is a
 * text-only form (type + title + details).
 */
export function FeedbackDrawer({ orgId }: FeedbackDrawerProps) {
  const { isOpen, close } = useDrawers();
  const open = isOpen("feedback");

  const [type, setType] = useState<FType>("FEATURE");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  function reset() {
    setType("FEATURE");
    setTitle("");
    setDescription("");
    setDone(false);
  }

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          title: title.trim(),
          description: description.trim(),
        }),
      });
      if (!res.ok) throw new Error("Failed to submit");
      setDone(true);
    } catch (err) {
      notifyError(err, "Couldn't submit your feedback.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          close();
          reset();
        }
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col p-0 sm:max-w-[460px]"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <MessageSquarePlus className="h-4 w-4 text-[var(--primary)]" />
            Feedback
          </span>
          <button
            type="button"
            onClick={() => close()}
            aria-label="Close feedback"
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {done ? (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <p className="text-sm font-medium">Thanks for the feedback!</p>
              <p className="text-xs text-muted-foreground">
                We&apos;ve recorded it. The team reviews requests by votes.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={reset}>
                  Submit another
                </Button>
                <Button size="sm" onClick={() => close()}>
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <p className="text-xs text-muted-foreground">
                Report a bug or request a feature without leaving your work.
                Others can upvote it.
              </p>

              <div className="space-y-1.5">
                <Label htmlFor="fb-drawer-type">Type</Label>
                <Select
                  value={type}
                  onValueChange={(v) => setType((v as FType) ?? "FEATURE")}
                >
                  <SelectTrigger id="fb-drawer-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FEATURE">Feature request</SelectItem>
                    <SelectItem value="BUG">Bug report</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="fb-drawer-title">Title</Label>
                <Input
                  id="fb-drawer-title"
                  placeholder="Short summary…"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  autoComplete="off"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="fb-drawer-desc">Details (optional)</Label>
                <Textarea
                  id="fb-drawer-desc"
                  placeholder="What happened, or what would you like?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="min-h-[120px]"
                />
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={submitting || !title.trim()}
              >
                {submitting ? "Submitting…" : "Submit feedback"}
              </Button>
            </form>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
