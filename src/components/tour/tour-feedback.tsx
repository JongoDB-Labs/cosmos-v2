"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TourStep } from "@/lib/tours/types";

/**
 * Send a question, idea or problem about the current step, from the card.
 *
 * Posts to the SAME feedback the rest of the product uses, so it lands in one
 * queue with everything else rather than a side channel somebody has to
 * remember to check. The step is recorded in the description because the person
 * reading it later needs to know what was on screen, and because a title
 * somebody did not write is a title they will send without reading.
 *
 * "Question" is filed as a feature request: the product has two kinds, and a
 * question is far closer to "there is something you have not told me" than to a
 * defect.
 */
const KINDS = [
  { key: "QUESTION", label: "Question", type: "FEATURE" },
  { key: "IDEA", label: "Idea", type: "FEATURE" },
  { key: "PROBLEM", label: "Problem", type: "BUG" },
] as const;

export function TourFeedback({
  orgId,
  step,
  tourName,
  tourId,
}: {
  orgId: string;
  step: TourStep;
  tourName: string;
  tourId: string;
}) {
  const [kind, setKind] = useState<(typeof KINDS)[number]["key"]>("QUESTION");
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function send() {
    const body = text.trim();
    if (!body) return;
    setState("sending");
    const chosen = KINDS.find((k) => k.key === kind)!;
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: chosen.type,
          // Titled from their own words so the queue reads as people wrote it,
          // trimmed to something a list can show.
          title: body.length > 72 ? body.slice(0, 69).trimEnd() + "…" : body,
          description:
            `${body}\n\n---\nRaised from the "${tourName}" walkthrough, ` +
            `step "${step.title}" (${tourId}/${step.id}). Marked as: ${chosen.label}.`,
        }),
      });
      setState(res.ok ? "sent" : "error");
      if (res.ok) setText("");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="mb-2 flex gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k.key}
            type="button"
            onClick={() => setKind(k.key)}
            aria-pressed={kind === k.key}
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs",
              kind === k.key
                ? "border-[var(--text)] text-[var(--text)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            {k.label}
          </button>
        ))}
      </div>

      <textarea
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (state !== "idle") setState("idle");
        }}
        placeholder="What is unclear, wrong, or missing?"
        aria-label={`Feedback about ${step.title}`}
        className="w-full rounded border border-[var(--border)] bg-[var(--surface-hover)] px-2 py-1 text-sm"
      />

      <div className="mt-1.5 flex items-center gap-2">
        <Button size="sm" onClick={() => void send()} disabled={state === "sending" || !text.trim()}>
          {state === "sending" ? "Sending…" : "Send"}
        </Button>
        {state === "sent" && (
          <span className="text-xs text-[var(--text-muted)]">Sent — it is in the feedback queue.</span>
        )}
        {state === "error" && <span className="text-xs text-red-600">Couldn&apos;t send just now.</span>}
      </div>
    </div>
  );
}
