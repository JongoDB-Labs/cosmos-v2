"use client";

import { useState } from "react";
import { MessageSquarePlus, Bug, Lightbulb, X } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import { useDrawers } from "./drawer-provider";

type FType = "BUG" | "FEATURE";

interface FeedbackDrawerProps {
  orgId: string;
}

const TYPE_OPTIONS: { value: FType; label: string; icon: typeof Bug }[] = [
  { value: "BUG", label: "Bug", icon: Bug },
  { value: "FEATURE", label: "Feature", icon: Lightbulb },
];

/**
 * Global slide-over for filing feedback without leaving the current screen.
 * POSTs to `POST /api/v1/orgs/[orgId]/feedback` with `{ type, title,
 * description }`. On success it toasts, clears the form, and closes the drawer.
 */
export function FeedbackDrawer({ orgId }: FeedbackDrawerProps) {
  const { isOpen, close } = useDrawers();
  const open = isOpen("feedback");

  const [type, setType] = useState<FType>("FEATURE");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function reset() {
    setType("FEATURE");
    setTitle("");
    setDescription("");
    setFormError(null);
  }

  async function submit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError("A title is required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          title: trimmedTitle,
          description: description.trim(),
        }),
      });
      if (!res.ok) {
        // Surface the API's human message inline when present.
        let message = "Couldn't submit your feedback.";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* non-JSON error body — keep the fallback */
        }
        setFormError(message);
        throw new Error(message);
      }
      toast.success("Thanks for the feedback!");
      reset();
      close();
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
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <p className="text-xs text-[var(--text-muted)]">
              Report a bug or request a feature without leaving your work.
              Others can upvote it.
            </p>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <div
                role="radiogroup"
                aria-label="Feedback type"
                className="flex gap-2"
              >
                {TYPE_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  const active = type === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setType(opt.value)}
                      className={cn(
                        "flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                        active
                          ? "border-[var(--primary)] bg-[var(--primary-tint)] text-[var(--primary)]"
                          : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fb-drawer-title">Title</Label>
              <Input
                id="fb-drawer-title"
                placeholder="Short summary…"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (formError) setFormError(null);
                }}
                autoComplete="off"
                aria-invalid={Boolean(formError)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fb-drawer-desc">Description (optional)</Label>
              <Textarea
                id="fb-drawer-desc"
                placeholder="What happened, or what would you like?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="min-h-[120px]"
              />
            </div>

            {formError && (
              <p className="text-xs text-[var(--status-critical-text)]">
                {formError}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={submitting || !title.trim()}
            >
              {submitting ? "Submitting…" : "Submit feedback"}
            </Button>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
