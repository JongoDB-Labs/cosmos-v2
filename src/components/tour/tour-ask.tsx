"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sparkles, Send, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TourStep } from "@/lib/tours/types";
import type { AskThread, AskTurn } from "./ask-threads";

/**
 * Ask about the current step, answered inside the card, as a conversation.
 *
 * In the card rather than the assistant drawer because the drawer covers the
 * very thing the step is pointing at — the reader would have to close it again
 * to look.
 *
 * Follow-ups go to the same conversation, so the model has the earlier
 * questions and answers; before, each question started a fresh conversation
 * and a reader had to restate everything to ask again. The thread itself is
 * held by the card (see ask-threads), temporary and per step, with a "New
 * conversation" to start over.
 *
 * The suggestions are chips beside a free-text box, never instead of it. They
 * save typing the questions everybody asks; they are not a menu of what may be
 * asked.
 */
export function TourAsk({
  orgId,
  step,
  tourName,
  thread,
  onThread,
  onReset,
}: {
  orgId: string;
  step: TourStep;
  tourName: string;
  thread: AskThread;
  onThread: (fn: (t: AskThread) => AskThread) => void;
  onReset: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const turns = thread.turns;

  // The newest turn's answer as it streams in.
  const setLast = (patch: Partial<AskTurn>) =>
    onThread((t) => ({
      ...t,
      turns: t.turns.map((turn, i) => (i === t.turns.length - 1 ? { ...turn, ...patch } : turn)),
    }));

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setQuestion("");
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const first = !thread.conversationId;
    onThread((t) => ({ ...t, turns: [...t.turns, { question: q, answer: "" }] }));

    try {
      let conversationId = thread.conversationId;
      if (!conversationId) {
        // Archived from the start: it is temporary, and does not belong in
        // the reader's assistant history while it exists.
        const convRes = await fetch(`/api/v1/orgs/${orgId}/assistant/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `${tourName}: ${step.title}`, archived: true }),
          signal: ctl.signal,
        });
        if (convRes.status === 403) throw new Error("forbidden");
        if (!convRes.ok) throw new Error("conversation");
        const conv = (await convRes.json()) as { data?: { id?: string }; id?: string };
        conversationId = conv.data?.id ?? conv.id ?? null;
        if (!conversationId) throw new Error("conversation");
        const id = conversationId;
        onThread((t) => ({ ...t, conversationId: id }));
      }

      const res = await fetch(
        `/api/v1/orgs/${orgId}/assistant/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            // The step's context once, with the first question; follow-ups are
            // just the question, and the conversation carries the rest.
            content: first
              ? `I am being walked through a change to this product and am looking at "${step.title}".\n\n` +
                `Context: ${step.blurb}\n${step.look}\n\n` +
                `My question: ${q}`
              : q,
          }),
          signal: ctl.signal,
        },
      );
      if (res.status === 403) throw new Error("forbidden");
      if (!res.ok || !res.body) throw new Error("send");

      // Read whatever the stream gives us and show it as it arrives. Server-sent
      // chunks carry JSON deltas; anything unparseable is skipped rather than
      // rendered raw, because half a JSON frame on screen reads as a bug.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!payload || payload === "[DONE]") continue;
          try {
            const frame = JSON.parse(payload) as Record<string, unknown>;
            const delta =
              (typeof frame.delta === "string" && frame.delta) ||
              (typeof frame.text === "string" && frame.text) ||
              (typeof frame.content === "string" && frame.content) ||
              "";
            if (delta) {
              text += delta;
              setLast({ answer: text });
            }
          } catch {
            /* partial frame — wait for the rest */
          }
        }
      }
      if (!text) setLast({ error: "No answer came back. The assistant may not be connected yet." });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setLast({
        error:
          (e as Error)?.message === "forbidden"
            ? "Your role cannot use the assistant, so this step has no Q&A."
            : "Couldn't ask just now.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      {(step.asks ?? []).length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {(step.asks ?? []).map((a) => (
            <button
              key={a}
              type="button"
              disabled={busy}
              onClick={() => {
                setQuestion(a);
                void ask(a);
              }}
              className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:border-[var(--text)] hover:text-[var(--text)] disabled:opacity-50"
            >
              {a}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void ask(question);
          }}
          placeholder={turns.length ? "Ask a follow-up…" : "Ask anything about this…"}
          aria-label={`Ask about ${step.title}`}
          disabled={busy}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--primary-tint)] px-2 py-1 text-sm"
        />
        <Button size="icon-xs" onClick={() => void ask(question)} disabled={busy || !question.trim()} aria-label="Ask">
          <Send className="size-3.5" />
        </Button>
      </div>

      {turns.length > 0 && (
        <div className="mt-2 max-h-72 space-y-3 overflow-y-auto" aria-label="Questions and answers" role="log">
          {turns.map((turn, i) => (
            <div key={i} className="space-y-1">
              <p className="ml-6 rounded bg-[var(--surface-raised,var(--border))] px-2.5 py-1.5 text-sm">{turn.question}</p>
              <div className="rounded bg-[var(--primary-tint)] px-2.5 py-2 text-sm">
                {turn.error ? (
                  <span className="text-red-600">{turn.error}</span>
                ) : turn.answer ? (
                  // The SAME renderer and prose classes the assistant panel uses, so a
                  // list, a table or a code block reads identically wherever the
                  // answer is shown. Rendering it as plain text here meant markdown
                  // arrived as literal asterisks and pipes.
                  <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-background prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.answer}</ReactMarkdown>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
                    <Sparkles className="size-3 animate-pulse" /> Thinking…
                  </span>
                )}
              </div>
            </div>
          ))}
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                abortRef.current?.abort();
                setQuestion("");
                onReset();
              }}
            >
              <RotateCcw className="mr-1 size-3.5" />
              New conversation
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
