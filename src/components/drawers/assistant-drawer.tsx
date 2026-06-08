"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Settings, X, Send, Plus, ExternalLink } from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import { useDrawers } from "./drawer-provider";

interface AssistantDrawerProps {
  orgId: string;
  orgSlug: string;
}

type Role = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: Role;
  /** Accumulated text. Empty while the assistant turn is still "Thinking…". */
  content: string;
  /** Transient "using {tool}…" status line, cleared once a result/text lands. */
  status?: string;
  /** Set when the turn ended with an error so the bubble can render it red. */
  error?: boolean;
}

type ModelAlias = "sonnet" | "opus" | "haiku";
const MODEL_OPTIONS: { value: ModelAlias; label: string }[] = [
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];
const MODEL_STORAGE_KEY = "cosmos:assistant:model";

type ProviderId = "claude-oauth" | "anthropic" | "openai";
interface ProviderStatus {
  provider: ProviderId | string;
  anthropic: { configured: boolean };
  openai: { configured: boolean; baseUrl?: string; model?: string };
  claudeOAuth: { connected: boolean; email?: string | null };
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  "claude-oauth": "Claude subscription (OAuth)",
  anthropic: "Anthropic API key",
  openai: "OpenAI-compatible",
};

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

/** Read the persisted model alias (client-only) for a lazy state initializer. */
function initialModel(): ModelAlias {
  if (typeof window === "undefined") return "sonnet";
  try {
    const saved = localStorage.getItem(MODEL_STORAGE_KEY);
    if (saved === "sonnet" || saved === "opus" || saved === "haiku") {
      return saved;
    }
  } catch {
    /* localStorage unavailable — fall back to the default */
  }
  return "sonnet";
}

/**
 * Global slide-over for the streaming assistant chat. Purpose-built for the
 * ~460px drawer (NOT the full-page AssistantPanel): a compact bubble list, an
 * autogrowing composer, and an INLINE settings panel (model + active provider)
 * toggled from the header gear.
 *
 * Streaming contract (see
 * `POST /api/v1/orgs/[orgId]/assistant/conversations/[id]/messages`):
 * creates a conversation lazily on first send, then reads an SSE body and maps
 * `text` / `tool_call_start` / `tool_call_result` / `done` / `error` events.
 */
export function AssistantDrawer({ orgId, orgSlug }: AssistantDrawerProps) {
  const { isOpen, close } = useDrawers();
  const open = isOpen("assistant");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [model, setModel] = useState<ModelAlias>(initialModel);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);

  const conversationIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Autoscroll to the newest message as content streams in.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Abort any in-flight stream when the drawer closes or unmounts.
  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    return () => {
      abortRef.current?.abort();
    };
  }, [open]);

  const fetchProvider = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/ai/provider`);
      if (!res.ok) return;
      setProvider((await res.json()) as ProviderStatus);
    } catch {
      /* provider panel is best-effort — silent on failure */
    }
  }, [orgId]);

  // Lazily load provider status the first time the settings panel opens.
  // fetchProvider sets state inside an async callback (not synchronously in the
  // effect body), matching the established fetch-on-open pattern in the other
  // drawers — scope-disable the rule here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (showSettings && !provider) void fetchProvider();
  }, [showSettings, provider, fetchProvider]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function selectModel(next: ModelAlias) {
    setModel(next);
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, next);
    } catch {
      /* ignore persistence failure */
    }
  }

  async function switchProvider(next: ProviderId) {
    setProviderSaving(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/ai/provider`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: next }),
      });
      if (!res.ok) throw new Error("Failed to switch provider");
      setProvider((prev) => (prev ? { ...prev, provider: next } : prev));
    } catch (err) {
      notifyError(err, "Couldn't switch the AI provider.");
    } finally {
      setProviderSaving(false);
    }
  }

  function newChat() {
    abortRef.current?.abort();
    abortRef.current = null;
    conversationIdRef.current = null;
    setMessages([]);
    setInput("");
    setBusy(false);
  }

  /** Patch the assistant bubble identified by `id` in place. */
  function patchMessage(id: string, patch: Partial<ChatMessage>) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );
  }

  async function ensureConversation(firstMessage: string): Promise<string> {
    if (conversationIdRef.current) return conversationIdRef.current;
    const title = firstMessage.slice(0, 40);
    const res = await fetch(
      `/api/v1/orgs/${orgId}/assistant/conversations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      },
    );
    if (!res.ok) throw new Error("Failed to start a conversation");
    const data = (await res.json()) as { id?: string; data?: { id?: string } };
    const id = data.id ?? data.data?.id;
    if (!id) throw new Error("Conversation response missing id");
    conversationIdRef.current = id;
    return id;
  }

  async function send() {
    const content = input.trim();
    if (!content || busy) return;

    const userMsg: ChatMessage = { id: nextId("u"), role: "user", content };
    const assistantId = nextId("a");
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", content: "", status: "" },
    ]);
    setInput("");
    setBusy(true);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const conversationId = await ensureConversation(content);
      const res = await fetch(
        `/api/v1/orgs/${orgId}/assistant/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({ content, model }),
          signal: abort.signal,
        },
      );

      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let gotText = false;

      // Loop over the SSE byte stream, splitting on the blank-line frame
      // delimiter and parsing the JSON payload of each `data:` line.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          const line = frame
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!line) continue;
          const json = line.slice(line.indexOf(":") + 1).trim();
          if (!json) continue;

          let evt: {
            type?: string;
            text?: string;
            name?: string;
            error?: string;
            message?: string;
          };
          try {
            evt = JSON.parse(json);
          } catch {
            continue;
          }

          if (evt.type === "text" && evt.text) {
            gotText = true;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + evt.text, status: "" }
                  : m,
              ),
            );
          } else if (evt.type === "tool_call_start") {
            patchMessage(assistantId, {
              status: `Using ${evt.name ?? "a tool"}…`,
            });
          } else if (evt.type === "tool_call_result") {
            patchMessage(assistantId, { status: "" });
          } else if (evt.type === "error") {
            patchMessage(assistantId, {
              content: evt.error ?? evt.message ?? "Something went wrong.",
              status: "",
              error: true,
            });
          } else if (evt.type === "done") {
            patchMessage(assistantId, { status: "" });
          }
        }
      }

      // A run that streamed neither text nor an error leaves an empty bubble;
      // surface a gentle fallback so the turn never looks silently dropped.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId && !gotText && !m.content && !m.error
            ? { ...m, content: "_(No response.)_", status: "" }
            : m,
        ),
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // User started a new chat / closed the drawer — drop the stub.
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      } else {
        notifyError(err, "The assistant couldn't respond.");
        patchMessage(assistantId, {
          content: "Sorry — I couldn't respond. Please try again.",
          status: "",
          error: true,
        });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const activeProvider = (provider?.provider ?? "") as ProviderId;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col p-0 sm:max-w-[460px]"
      >
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-[var(--primary)]" />
            Assistant
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={newChat}
              aria-label="New chat"
              title="New chat"
              className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowSettings((s) => !s)}
              aria-label="AI settings"
              aria-pressed={showSettings}
              title="AI settings"
              className={cn(
                "rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
                showSettings && "bg-[var(--primary-tint)] text-[var(--text)]",
              )}
            >
              <Settings className="h-4 w-4" />
            </button>
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

        {/* Inline settings */}
        {showSettings && (
          <div className="shrink-0 space-y-3 border-b border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-muted)]">
                Model
              </label>
              <div className="flex gap-1.5">
                {MODEL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => selectModel(opt.value)}
                    aria-pressed={model === opt.value}
                    className={cn(
                      "flex-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                      model === opt.value
                        ? "border-[var(--primary)] bg-[var(--primary-tint)] text-[var(--primary)]"
                        : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="assistant-provider"
                className="text-xs font-medium text-[var(--text-muted)]"
              >
                Active provider
              </label>
              {provider ? (
                <select
                  id="assistant-provider"
                  value={activeProvider}
                  disabled={providerSaving}
                  onChange={(e) =>
                    void switchProvider(e.target.value as ProviderId)
                  }
                  className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm outline-none focus-visible:border-ring disabled:opacity-50"
                >
                  <option value="claude-oauth">
                    {PROVIDER_LABEL["claude-oauth"]}
                    {provider.claudeOAuth.connected ? " ✓" : ""}
                  </option>
                  <option value="anthropic">
                    {PROVIDER_LABEL.anthropic}
                    {provider.anthropic.configured ? " ✓" : ""}
                  </option>
                  <option value="openai">
                    {PROVIDER_LABEL.openai}
                    {provider.openai.configured ? " ✓" : ""}
                  </option>
                </select>
              ) : (
                <p className="text-xs text-[var(--text-muted)]">
                  Loading providers…
                </p>
              )}
              {provider?.claudeOAuth.connected &&
                provider.claudeOAuth.email && (
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Signed in as {provider.claudeOAuth.email}
                  </p>
                )}
            </div>

            <Link
              href={`/${orgSlug}/settings/ai`}
              onClick={() => close()}
              className="inline-flex items-center gap-1 text-xs font-medium text-[var(--primary)] hover:underline"
            >
              Configure providers
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <Sparkles className="mb-3 h-8 w-8 text-[var(--primary)]" />
              <p className="text-sm font-medium text-[var(--text)]">
                Ask the assistant
              </p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Query project data, draft updates, or get answers — it can use
                tools to act on your workspace.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={cn(
                    "flex",
                    m.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                      m.role === "user"
                        ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                        : m.error
                          ? "border border-[var(--status-critical-text)]/30 bg-destructive/10 text-[var(--status-critical-text)]"
                          : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
                    )}
                  >
                    {m.role === "user" ? (
                      <p className="whitespace-pre-wrap break-words">
                        {m.content}
                      </p>
                    ) : m.content ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none break-words prose-pre:bg-background prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {m.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <span className="italic text-[var(--text-muted)]">
                        {m.status || "Thinking…"}
                      </span>
                    )}
                    {m.content && m.status && (
                      <p className="mt-1 text-xs italic text-[var(--text-muted)]">
                        {m.status}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-[var(--border)] p-3">
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Ask the assistant…"
              rows={1}
              className="max-h-40 min-h-[40px] flex-1 resize-none"
            />
            <Button
              type="button"
              size="icon"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
