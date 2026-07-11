"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CosmoAvatar } from "./cosmo-avatar";
import { useDictation } from "@/lib/hooks/use-dictation";
import { DEFAULT_CLOSE_WORD } from "@/lib/voice/close-word";
import { notifyError } from "@/lib/errors/notify";
import { EntityMentionPicker } from "@/components/mentions/entity-mention-picker";
import { detectMentionQuery, insertMentionToken } from "@/lib/mentions/input";
import type { ResolvedEntity } from "@/lib/mentions/refs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Send,
  Square,
  Archive,
  Trash2,
  MessageCircle,
  ChevronRight,
  ChevronLeft,
  Paperclip,
  Mic,
  X,
  Loader2,
  Wrench,
  Settings,
  ExternalLink,
} from "lucide-react";

// =============================================================================
// Types
// =============================================================================

interface AssistantConversation {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messages?: AssistantMessage[];
  _count?: { messages: number };
}

interface LiveToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown | null;
  status: "running" | "done";
}

interface AssistantMessage {
  id: string;
  conversationId: string;
  role: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  content: string;
  toolCalls: Record<string, unknown>[] | LiveToolCall[];
  toolCallId: string | null;
  createdAt: string;
}

interface Attachment {
  name: string;
  content: string;
  size: number;
}

interface AssistantPanelProps {
  orgId: string;
}

// =============================================================================
// Constants
// =============================================================================

const MODEL_STORAGE_KEY = "cosmos.chatModel";
const MODEL_OPTIONS = [
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
] as const;
type ModelValue = (typeof MODEL_OPTIONS)[number]["value"];
const DEFAULT_MODEL: ModelValue = "sonnet";

// Provider settings (merged in from the former drawer panel) — the agent auths
// via the org's chosen provider; this lets the user switch it inline.
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

// Text-only attachment extensions for Phase 4. Binary handling (images, PDFs,
// .docx) is deferred to Phase 4b — we need to decide how to pipe non-text
// payloads through the CLI before we can ship that.
const TEXT_ATTACHMENT_EXTS = [
  ".txt", ".md", ".csv", ".json", ".yaml", ".yml",
  ".html", ".js", ".ts", ".py", ".sh", ".sql", ".log",
];
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB total

// Friendly badges for known tools; falls back to `Running ${name}` for
// anything not listed. Keep verbs in the present-progressive — these labels
// surface while the tool is still executing.
const TOOL_LABELS: Record<string, string> = {
  create_project: "Creating project",
  update_project: "Updating project",
  delete_project: "Deleting project",
  list_projects: "Listing projects",
  get_project: "Loading project",
  create_work_item: "Creating work item",
  update_work_item: "Updating work item",
  delete_work_item: "Deleting work item",
  list_work_items: "Listing work items",
  create_okr: "Creating OKR",
  update_okr: "Updating OKR",
  list_okrs: "Listing OKRs",
  send_email: "Sending email",
  search_emails: "Searching emails",
  list_emails: "Listing emails",
  create_calendar_event: "Creating calendar event",
  list_calendar_events: "Listing calendar events",
  search_files: "Searching files",
  read_file: "Reading file",
  write_file: "Writing file",
};

function labelForTool(name: string | undefined): string {
  if (!name) return "Running tool";
  return TOOL_LABELS[name] ?? `Running ${name}`;
}

/**
 * Convert a present-progressive tool label ("Creating project") to its
 * past-tense form ("Created project") for the post-execution badge.
 * Falls back to `Ran ${name}` when we don't have a canonical mapping —
 * the naive `-ing` → `-ed` substitution produces garbage like "Runned".
 */
function pastTenseLabel(name: string | undefined): string {
  if (!name) return "Ran tool";
  const known = TOOL_LABELS[name];
  if (!known) return `Ran ${name}`;
  // Curated past-tense mappings keyed by the canonical present label.
  // Anything not listed falls through to a regex substitution that handles
  // the common "Verbing" → "Verbed" / "Verb-y" → "Verbed" cases.
  const map: Record<string, string> = {
    "Creating project": "Created project",
    "Updating project": "Updated project",
    "Deleting project": "Deleted project",
    "Listing projects": "Listed projects",
    "Loading project": "Loaded project",
    "Creating work item": "Created work item",
    "Updating work item": "Updated work item",
    "Deleting work item": "Deleted work item",
    "Listing work items": "Listed work items",
    "Creating OKR": "Created OKR",
    "Updating OKR": "Updated OKR",
    "Listing OKRs": "Listed OKRs",
    "Sending email": "Sent email",
    "Searching emails": "Searched emails",
    "Listing emails": "Listed emails",
    "Creating calendar event": "Created calendar event",
    "Listing calendar events": "Listed calendar events",
    "Searching files": "Searched files",
    "Reading file": "Read file",
    "Writing file": "Wrote file",
  };
  return map[known] ?? known;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// =============================================================================
// Component
// =============================================================================

export function AssistantPanel({ orgId }: AssistantPanelProps) {
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1] ?? "";
  const [showSettings, setShowSettings] = useState(false);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState("");
  // Voice dictation (reference UX: okr-dashboard ChatPanel). The close word is
  // the user's Preferences → Voice phrase; a completed dictation writes the
  // message into `input` and bumps the tick, and the effect below sends once
  // the state has committed (calling sendMessage() directly here would read a
  // stale `input` closure).
  const [closeWord, setCloseWord] = useState<string | null>(null);
  const voiceTickRef = useRef(0);
  const [voiceTick, setVoiceTick] = useState(0);
  const dictation = useDictation({
    onTranscript: setInput,
    onSend: (text) => {
      setInput(text);
      setVoiceTick((t) => t + 1);
    },
    closeWord,
  });
  // @-mention typeahead. Tokens are inserted id-only (`<@type:id>`) and travel
  // to the assistant as opaque ids — never expanded to CUI content client-side;
  // any server-side expansion must go through the egress gate.
  const [mentionState, setMentionState] = useState<{
    q: string;
    anchor: { top: number; left: number };
  } | null>(null);
  const [loadingConvos, setLoadingConvos] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  // The conversation-history list starts COLLAPSED so opening the assistant
  // leads straight into the chat (more room; history is one click away via the
  // toggle). Was open-by-default, which buried the conversation on open.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelValue>(() => {
    if (typeof window === "undefined") return DEFAULT_MODEL;
    try {
      const stored = window.localStorage.getItem(MODEL_STORAGE_KEY);
      if (stored && MODEL_OPTIONS.some((m) => m.value === stored)) {
        return stored as ModelValue;
      }
    } catch {
      /* localStorage unavailable */
    }
    return DEFAULT_MODEL;
  });
  // Status surfaced inside the streaming bubble before any text arrives.
  // Pair of (label, startTimestampMs). The elapsed counter is rendered from
  // an interval that re-renders the bubble once per second.
  const [streamingStatus, setStreamingStatus] = useState<
    { label: string; startedAt: number } | null
  >(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [prevStatusStart, setPrevStatusStart] = useState<number | null>(null);
  // Reset elapsed when a new status begins or status clears (avoids setState
  // in effect by leaning on React's "store the previous value" pattern).
  const currentStart = streamingStatus?.startedAt ?? null;
  if (prevStatusStart !== currentStart) {
    setPrevStatusStart(currentStart);
    setElapsedSeconds(0);
  }

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the bottom. While streaming, we only
  // auto-scroll when the user is already at the bottom — so scrolling up to
  // re-read earlier text isn't yanked back down on every token.
  const stickToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Tick the elapsed counter once per second while a status is active.
  useEffect(() => {
    if (!streamingStatus) return;
    const id = setInterval(() => {
      setElapsedSeconds((n) => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [streamingStatus]);


  const handleModelChange = useCallback((value: string | null) => {
    if (!value || !MODEL_OPTIONS.some((m) => m.value === value)) return;
    setModel(value as ModelValue);
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, value);
    } catch {
      /* ignore */
    }
  }, []);

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
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (showSettings && !provider) void fetchProvider();
  }, [showSettings, provider, fetchProvider]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const switchProvider = useCallback(
    async (next: ProviderId) => {
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
    },
    [orgId],
  );

  // Track the user's scroll position so streaming doesn't fight them. "At
  // bottom" = within 80px of the end.
  const handleMessagesScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (el) {
      // Instant (not smooth) — a smooth animation per token stutters and the
      // animations fight each other on a fast stream. Pinning the scrollTop is
      // both smoother-feeling and cheaper.
      el.scrollTop = el.scrollHeight;
    } else {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingConvos(true);
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/assistant/conversations`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setConversations(Array.isArray(data) ? data : data.conversations || []);
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoadingConvos(false);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  // The conversation list is an in-flow sidebar on desktop but an overlay
  // drawer on mobile; default it closed on small screens so the chat pane gets
  // the full width on first load (set post-mount to avoid a hydration mismatch).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
  }, []);

  const fetchMessages = useCallback(
    async (conversationId: string) => {
      setLoadingMessages(true);
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/assistant/conversations/${conversationId}/messages`
        );
        if (res.ok) {
          const data = await res.json();
          setMessages(
            Array.isArray(data) ? data : data.messages || []
          );
        }
      } catch {
        /* ignore */
      } finally {
        setLoadingMessages(false);
      }
    },
    [orgId]
  );

  const selectConversation = useCallback(
    (id: string) => {
      setActiveId(id);
      setMessages([]);
      fetchMessages(id);
      // On mobile the conversation list is an overlay drawer — close it so the
      // selected conversation (and its composer) is visible.
      if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
    },
    [fetchMessages]
  );

  const createConversation = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/assistant/conversations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "New conversation" }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const convo = await res.json();
      setConversations((prev) => [convo, ...prev]);
      setActiveId(convo.id);
      setMessages([]);
    } catch (err) {
      console.error("Failed to create conversation:", err);
      notifyError(err, "Couldn't start a new conversation.");
    }
  }, [orgId]);

  const archiveConversation = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/assistant/conversations/${id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: true }),
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (activeId === id) {
          setActiveId(null);
          setMessages([]);
        }
      } catch (err) {
        console.error("Failed to archive conversation:", err);
        notifyError(err, "Couldn't archive the conversation.");
      }
    },
    [orgId, activeId]
  );

  const deleteConversation = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/assistant/conversations/${id}`,
          { method: "DELETE" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (activeId === id) {
          setActiveId(null);
          setMessages([]);
        }
      } catch (err) {
        console.error("Failed to delete conversation:", err);
        notifyError(err, "Couldn't delete the conversation.");
      }
    },
    [orgId, activeId]
  );

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  const handleFilesSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      // Reset the input so picking the same file twice re-fires onchange.
      e.target.value = "";
      if (files.length === 0) return;

      setAttachmentError(null);
      const next: Attachment[] = [];
      let runningTotal = attachments.reduce((sum, a) => sum + a.size, 0);

      for (const file of files) {
        const lowerName = file.name.toLowerCase();
        const ext = lowerName.includes(".")
          ? lowerName.slice(lowerName.lastIndexOf("."))
          : "";
        if (!TEXT_ATTACHMENT_EXTS.includes(ext)) {
          setAttachmentError(
            `${file.name}: only text files are supported right now`,
          );
          continue;
        }
        if (runningTotal + file.size > MAX_ATTACHMENT_BYTES) {
          setAttachmentError(
            `Total attachment size exceeds 5MB. Skipping ${file.name}.`,
          );
          continue;
        }
        try {
          const text = await file.text();
          next.push({ name: file.name, content: text, size: file.size });
          runningTotal += file.size;
        } catch {
          setAttachmentError(`Could not read ${file.name}`);
        }
      }
      if (next.length > 0) {
        setAttachments((prev) => [...prev, ...next]);
      }
    },
    [attachments],
  );

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // ---------------------------------------------------------------------------
  // Send / Stop
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/orgs/${orgId}/preferences`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!alive) return;
        const prefs = (body?.data ?? body) as { voiceCloseWord?: string | null } | null;
        setCloseWord(prefs?.voiceCloseWord ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [orgId]);

  const sendMessage = useCallback(async () => {
    if ((!input.trim() && attachments.length === 0) || sending) return;

    let currentActiveId = activeId;

    if (!currentActiveId) {
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/assistant/conversations`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: (input.trim() || attachments[0]?.name || "New conversation")
                .slice(0, 60),
            }),
          }
        );
        if (res.ok) {
          const convo = await res.json();
          currentActiveId = convo.id;
          setConversations((prev) => [convo, ...prev]);
          setActiveId(convo.id);
        } else {
          // Don't silently swallow — the input is preserved, but tell the user
          // why nothing happened so they can retry.
          notifyError(
            new Error(`HTTP ${res.status}`),
            "Couldn't start a conversation. Please try again.",
          );
          return;
        }
      } catch (err) {
        notifyError(err, "Couldn't start a conversation. Please try again.");
        return;
      }
    }

    // Build the payload content with attachment text prepended. The user
    // bubble still shows the typed message verbatim — only the model sees
    // the file bodies inline.
    const trimmedInput = input.trim();
    const attachmentBlock = attachments
      .map((a) => `[File: ${a.name}]\n${a.content}`)
      .join("\n\n");
    const payloadContent = attachments.length > 0
      ? `${attachmentBlock}${trimmedInput ? `\n\n${trimmedInput}` : ""}`
      : trimmedInput;

    // The displayed user message: input plus paperclip chips for context.
    const displayContent = attachments.length > 0
      ? `${trimmedInput}${trimmedInput ? "\n\n" : ""}${attachments
          .map((a) => `[File: ${a.name}]`)
          .join("\n")}`
      : trimmedInput;

    const userMessage: AssistantMessage = {
      id: `temp-${Date.now()}`,
      conversationId: currentActiveId!,
      role: "USER",
      content: displayContent,
      toolCalls: [],
      toolCallId: null,
      createdAt: new Date().toISOString(),
    };

    const streamingId = `streaming-${Date.now()}`;
    const streamingMessage: AssistantMessage = {
      id: streamingId,
      conversationId: currentActiveId!,
      role: "ASSISTANT",
      content: "",
      toolCalls: [],
      toolCallId: null,
      createdAt: new Date().toISOString(),
    };

    // Sending always re-pins to the bottom — you want to see your own message
    // and the reply, regardless of where you'd scrolled.
    stickToBottomRef.current = true;
    setMessages((prev) => [...prev, userMessage, streamingMessage]);
    setInput("");
    setAttachments([]);
    setAttachmentError(null);
    setSending(true);
    // Start the "Thinking…" indicator immediately; the first text/tool event
    // will replace it.
    setStreamingStatus({ label: "Thinking", startedAt: Date.now() });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/assistant/conversations/${currentActiveId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({ content: payloadContent, model }),
          signal: controller.signal,
        }
      );

      if (!res.ok) {
        // Let the catch below remove the pending bubble and toast the error.
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.body) {
        // OK but non-streaming: use the JSON payload directly.
        const data = await res.json();
        const newMsgs: AssistantMessage[] = Array.isArray(data) ? data : [data];
        setMessages((prev) => {
          const filtered = prev.filter(
            (m) => m.id !== userMessage.id && m.id !== streamingId,
          );
          return [...filtered, userMessage, ...newMsgs];
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      const liveToolCalls: LiveToolCall[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIdx = buffer.indexOf("\n\n");
        while (sepIdx !== -1) {
          const chunk = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          const dataLine = chunk
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (dataLine) {
            const json = dataLine.slice(5).trim();
            try {
              const evt = JSON.parse(json) as {
                type: string;
                text?: string;
                name?: string;
                arguments?: Record<string, unknown>;
                id?: string;
                result?: unknown;
                content?: string;
                toolCalls?: Record<string, unknown>[];
                messageId?: string;
                message?: string;
              };
              if (evt.type === "text" && evt.text) {
                accumulated += evt.text;
                // First token clears the "Thinking…" status.
                setStreamingStatus(null);
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingId
                      ? { ...m, content: accumulated }
                      : m,
                  ),
                );
              } else if (evt.type === "tool_call_start") {
                const tc: LiveToolCall = {
                  id: evt.id ?? `tc_${liveToolCalls.length + 1}`,
                  name: evt.name ?? "tool",
                  arguments: evt.arguments ?? {},
                  result: null,
                  status: "running",
                };
                liveToolCalls.push(tc);
                setStreamingStatus({
                  label: labelForTool(evt.name),
                  startedAt: Date.now(),
                });
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingId
                      ? { ...m, toolCalls: [...liveToolCalls] }
                      : m,
                  ),
                );
              } else if (evt.type === "tool_call_result") {
                const tc = liveToolCalls.find((t) => t.id === evt.id);
                if (tc) {
                  tc.result = evt.result;
                  tc.status = "done";
                }
                // Clear status — if more tools follow, the next start event
                // will set a new one.
                setStreamingStatus(null);
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingId
                      ? { ...m, toolCalls: [...liveToolCalls] }
                      : m,
                  ),
                );
              } else if (evt.type === "done") {
                setStreamingStatus(null);
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingId
                      ? {
                          ...m,
                          id: evt.messageId ?? m.id,
                          content: evt.content ?? accumulated,
                          toolCalls: evt.toolCalls ?? liveToolCalls,
                        }
                      : m,
                  ),
                );
              } else if (evt.type === "error") {
                setStreamingStatus(null);
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingId
                      ? {
                          ...m,
                          content:
                            accumulated +
                            (accumulated ? "\n\n" : "") +
                            `_Error: ${evt.message ?? "unknown"}_`,
                        }
                      : m,
                  ),
                );
              }
            } catch {
              /* skip malformed event */
            }
          }
          sepIdx = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      // AbortError from the Stop button: keep whatever the user has accumulated
      // so far. Any other failure with no streamed text gets the bubble removed.
      const isAbort =
        err instanceof DOMException && err.name === "AbortError";
      if (!isAbort) {
        // Keep the user's message and turn the (possibly partial) streaming
        // bubble into an inline error, so the failure is anchored to the right
        // exchange instead of leaving the user message hanging with no reply.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingId
              ? {
                  ...m,
                  content:
                    (m.content ? `${m.content}\n\n` : "") +
                    "⚠️ The assistant couldn't finish responding. Please try again.",
                }
              : m,
          ),
        );
        notifyError(err, "The assistant couldn't respond. Please try again.");
      }
    } finally {
      setSending(false);
      setStreamingStatus(null);
      abortRef.current = null;
    }
  }, [input, sending, activeId, orgId, attachments, model]);

  // Voice: send once the dictated message has committed to `input` (tick-guarded
  // so this fires exactly once per completed dictation, never on keystrokes).
  useEffect(() => {
    if (voiceTick !== voiceTickRef.current) {
      voiceTickRef.current = voiceTick;
      // Deferred: sendMessage sets state; calling it synchronously inside the
      // effect trips the cascading-render lint. A microtask keeps ordering.
      if (input.trim()) queueMicrotask(() => sendMessage());
    }
  }, [voiceTick, input, sendMessage]);

  // Wake path: "Hey Cosmo" opens this panel and asks it to start dictation.
  useEffect(() => {
    const onStart = () => dictation.start();
    window.addEventListener("cosmos:assistant:dictation:start", onStart);
    return () => window.removeEventListener("cosmos:assistant:dictation:start", onStart);
  }, [dictation]);

  // Tell the wake-word provider when the chat mic is live so the two listeners
  // never fight over the microphone (reference: okr-dashboard's chatOpen gate).
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("cosmos:assistant:dictation:state", { detail: dictation.listening }),
    );
    return () => {
      if (dictation.listening) {
        window.dispatchEvent(new CustomEvent("cosmos:assistant:dictation:state", { detail: false }));
      }
    };
  }, [dictation.listening]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    // Defensive cleanup — the fetch's catch/finally also clears these, but
    // abort() resolution can be asynchronous and we want the UI to flip
    // immediately.
    setSending(false);
    setStreamingStatus(null);
  }, []);

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      setInput(v);
      const q = detectMentionQuery(v, e.target.selectionStart ?? v.length);
      if (q !== null) {
        const rect = e.target.getBoundingClientRect();
        setMentionState({ q, anchor: { top: rect.top - 8 - 220, left: rect.left + 24 } });
      } else {
        setMentionState(null);
      }
    },
    [],
  );

  const pickEntity = useCallback(
    (hit: ResolvedEntity) => {
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? input.length;
      const { value, caret: nc } = insertMentionToken(input, caret, hit.type, hit.id);
      setInput(value);
      setMentionState(null);
      requestAnimationFrame(() => {
        ta?.focus();
        ta?.setSelectionRange(nc, nc);
      });
    },
    [input],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionState) return; // let the mention picker handle Enter/Arrows/Esc
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage, mentionState]
  );

  const toggleToolExpand = useCallback((messageId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });
    }
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  const totalAttachmentSize = useMemo(
    () => attachments.reduce((s, a) => s + a.size, 0),
    [attachments],
  );

  // TODO Phase 4b — voice input (Web Speech API) and binary attachments
  // (images, PDFs, .docx). The okr-dashboard reference has a SpeechRecognition
  // integration with a "send it" trigger phrase; we'll port that once we
  // have product agreement on the UX.

  return (
    // Fills the host (the page wraps this in a full-height flex column), so the
    // composer pins to the viewport bottom instead of overflowing below it.
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden">
      {/* Mobile backdrop: the conversation list overlays the chat on small
          screens (so the chat keeps full width), dismissable by tapping away. */}
      {sidebarOpen && (
        <div
          className="absolute inset-0 z-20 bg-black/30 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}
      <div
        className={cn(
          // In-flow sidebar on desktop; absolute overlay drawer on mobile so it
          // never starves the chat pane (which otherwise clipped its content).
          "flex flex-col border-r bg-muted/30 transition-all duration-200 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:shadow-xl",
          sidebarOpen ? "w-60" : "w-0 overflow-hidden"
        )}
      >
        <div className="flex items-center justify-between p-3 border-b">
          <span className="text-sm font-semibold truncate">Conversations</span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="New conversation"
            onClick={createConversation}
          >
            <Plus className="size-4" />
          </Button>
        </div>

        {/* tabIndex makes the scroll region keyboard-reachable even when the
            list is empty (no focusable children) — axe scrollable-region-focusable. */}
        <div tabIndex={0} className="flex-1 overflow-y-auto">
          {loadingConvos ? (
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-md" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
              <MessageCircle className="size-8 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                No conversations yet
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5 p-2">
              {conversations.map((convo) => (
                // The row is a plain container; the SELECT action is its own
                // <button> and the archive/delete buttons are SIBLINGS (overlaid
                // top-right), never nested inside it — avoiding both invalid
                // <button>-in-<button> and the ARIA nested-interactive violation.
                <div
                  key={convo.id}
                  className={cn(
                    "group relative rounded-md transition-colors",
                    activeId === convo.id
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectConversation(convo.id)}
                    className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 pr-12 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="text-sm font-medium truncate">
                      {convo.title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(convo.updatedAt)}
                    </span>
                  </button>
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      onClick={(e) => archiveConversation(convo.id, e)}
                      className="rounded p-0.5 hover:bg-muted-foreground/20"
                      aria-label="Archive conversation"
                    >
                      <Archive className="size-3 text-muted-foreground" />
                    </button>
                    <button
                      onClick={(e) => deleteConversation(convo.id, e)}
                      className="rounded p-0.5 hover:bg-destructive/20"
                      aria-label="Delete conversation"
                    >
                      <Trash2 className="size-3 text-destructive" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col min-w-0">
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={sidebarOpen ? "Hide conversation list" : "Show conversation list"}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? (
              <ChevronLeft className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </Button>
          <h2 className="text-sm font-medium truncate flex-1">
            {activeId
              ? conversations.find((c) => c.id === activeId)?.title ??
                "Conversation"
              : "Cosmo"}
          </h2>
          <Select value={model} onValueChange={handleModelChange}>
            <SelectTrigger
              size="sm"
              className="min-w-24"
              aria-label="Select AI model"
            >
              <SelectValue placeholder="Model" />
            </SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="AI settings"
            aria-pressed={showSettings}
            onClick={() => setShowSettings((s) => !s)}
            className={cn(showSettings && "bg-accent text-accent-foreground")}
          >
            <Settings className="size-4" />
          </Button>
        </div>

        {/* Inline provider settings (gear) — pick which credential the agent
            uses. Mirrors the former drawer panel; the model selector lives in
            the header above. */}
        {showSettings && (
          <div className="shrink-0 space-y-1.5 border-b bg-muted/30 px-4 py-3 text-sm">
            <label
              htmlFor="assistant-provider"
              className="text-xs font-medium text-muted-foreground"
            >
              Active provider
            </label>
            {provider ? (
              <select
                id="assistant-provider"
                value={(provider.provider ?? "") as ProviderId}
                disabled={providerSaving}
                onChange={(e) =>
                  void switchProvider(e.target.value as ProviderId)
                }
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring disabled:opacity-50"
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
              <p className="text-xs text-muted-foreground">Loading providers…</p>
            )}
            {provider?.claudeOAuth.connected && provider.claudeOAuth.email && (
              <p className="text-[11px] text-muted-foreground">
                Signed in as {provider.claudeOAuth.email}
              </p>
            )}
            <Link
              href={`/${orgSlug}/settings/ai`}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Configure providers
              <ExternalLink className="size-3" />
            </Link>
          </div>
        )}

        <div
          ref={scrollContainerRef}
          onScroll={handleMessagesScroll}
          className="flex-1 overflow-y-auto px-4 py-4"
        >
          {!activeId ? (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <CosmoAvatar size={64} />
              <div className="text-center">
                <h3 className="text-lg font-semibold">Cosmo — your agentic AI chat assistant</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Ask questions about your projects, get insights, or have Cosmo take actions for you.
                </p>
              </div>
              <Button onClick={createConversation}>
                <Plus className="size-4" />
                New Conversation
              </Button>
            </div>
          ) : loadingMessages ? (
            <div className="flex flex-col gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex",
                    i % 2 === 0 ? "justify-end" : "justify-start"
                  )}
                >
                  <Skeleton
                    className={cn(
                      "h-16 rounded-xl",
                      i % 2 === 0 ? "w-2/5" : "w-3/5"
                    )}
                  />
                </div>
              ))}
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <CosmoAvatar size={40} />
              <p className="text-sm text-muted-foreground">
                Send a message to start the conversation.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3 max-w-3xl mx-auto">
              {messages.map((msg) => {
                const isLastStreaming =
                  sending &&
                  msg.role === "ASSISTANT" &&
                  msg.id.startsWith("streaming-");
                return (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    expanded={expandedTools.has(msg.id)}
                    onToggleTool={() => toggleToolExpand(msg.id)}
                    status={isLastStreaming ? streamingStatus : null}
                    elapsedSeconds={isLastStreaming ? elapsedSeconds : 0}
                  />
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="border-t bg-background px-4 py-3">
          <div className="flex flex-col gap-2 max-w-3xl mx-auto">
            {(attachments.length > 0 || attachmentError) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {attachments.map((a, idx) => (
                  <span
                    key={`${a.name}-${idx}`}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs"
                  >
                    <Paperclip className="size-3 text-muted-foreground" />
                    <span className="font-medium truncate max-w-40">{a.name}</span>
                    <span className="text-muted-foreground">
                      {formatBytes(a.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(idx)}
                      className="rounded hover:bg-muted-foreground/20 p-0.5"
                      aria-label={`Remove ${a.name}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                {attachments.length > 0 && (
                  <span className="text-xs text-muted-foreground ml-1">
                    {formatBytes(totalAttachmentSize)} total
                  </span>
                )}
                {attachmentError && (
                  <span className="text-xs text-destructive">
                    {attachmentError}
                  </span>
                )}
              </div>
            )}
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={TEXT_ATTACHMENT_EXTS.join(",")}
                onChange={handleFilesSelected}
                className="hidden"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={sending}
                aria-label="Attach file"
              >
                <Paperclip className="size-4" />
              </Button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  if (!dictation.listening) onInputChange(e);
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  dictation.listening
                    ? `Listening… say “${(closeWord ?? DEFAULT_CLOSE_WORD).trim() || DEFAULT_CLOSE_WORD}” to send`
                    : activeId
                      ? "Type a message... (@ to mention)"
                      : "Type a message to start a new conversation... (@ to mention)"
                }
                disabled={sending}
                rows={1}
                className="flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2.5 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 max-h-32 field-sizing-content"
              />
              {mentionState && (
                <EntityMentionPicker
                  orgId={orgId}
                  query={mentionState.q}
                  anchor={mentionState.anchor}
                  onPick={pickEntity}
                  onCancel={() => setMentionState(null)}
                />
              )}
              {dictation.supported && (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
                  aria-label={dictation.listening ? "Stop voice input" : "Start voice input"}
                  title={dictation.listening ? "Stop voice input" : "Voice input"}
                  className={
                    dictation.listening
                      ? "text-destructive bg-destructive/10 border border-destructive/40 animate-pulse"
                      : "text-muted-foreground"
                  }
                >
                  <Mic className="size-4" />
                </Button>
              )}
              {sending ? (
                <Button
                  size="icon"
                  variant="destructive"
                  onClick={handleStop}
                  aria-label="Stop generating"
                >
                  <Square className="size-4 fill-current" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={sendMessage}
                  disabled={!input.trim() && attachments.length === 0}
                  aria-label="Send message"
                >
                  <Send className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// MessageBubble
// =============================================================================

function MessageBubble({
  message,
  expanded,
  onToggleTool,
  status,
  elapsedSeconds,
}: {
  message: AssistantMessage;
  expanded: boolean;
  onToggleTool: () => void;
  status: { label: string; startedAt: number } | null;
  elapsedSeconds: number;
}) {
  if (message.role === "USER") {
    return (
      <div className="flex justify-end">
        <div className="rounded-xl bg-primary text-primary-foreground px-4 py-2.5 max-w-[80%]">
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  if (message.role === "TOOL") {
    return (
      <div className="flex items-start gap-2">
        <div className="size-6 shrink-0" />
        <div className="max-w-[80%]">
          <button
            onClick={onToggleTool}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronRight
              className={cn(
                "size-3 transition-transform",
                expanded && "rotate-90"
              )}
            />
            Tool result
            {message.toolCallId && (
              <span className="font-mono text-[10px] opacity-60">
                {message.toolCallId}
              </span>
            )}
          </button>
          {expanded && (
            <div className="mt-1.5 rounded-md border bg-muted/50 p-2.5 overflow-x-auto">
              <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
                {message.content}
              </pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.role === "SYSTEM") {
    return (
      <div className="flex justify-center">
        <span className="text-xs text-muted-foreground italic px-3 py-1 bg-muted/50 rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  // ASSISTANT
  const toolCalls = (message.toolCalls ?? []) as LiveToolCall[];
  const hasContent = message.content.length > 0;

  return (
    <div className="flex items-start gap-2">
      <CosmoAvatar size={24} className="mt-0.5" />
      <div className="rounded-xl bg-muted px-4 py-2.5 max-w-[80%] min-w-0">
        {toolCalls.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {toolCalls.map((tc) => (
              <span
                key={tc.id}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]",
                  tc.status === "done"
                    ? "border-border bg-background text-muted-foreground"
                    : "border-primary/30 bg-primary/10 text-primary",
                )}
              >
                {tc.status === "done" ? (
                  <Wrench className="size-3" />
                ) : (
                  <Loader2 className="size-3 animate-spin" />
                )}
                {tc.status === "done"
                  ? pastTenseLabel(tc.name)
                  : `${labelForTool(tc.name)}…`}
              </span>
            ))}
          </div>
        )}
        {hasContent ? (
          <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-background prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        ) : status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>
              {status.label}
              <span className="opacity-60"> ({elapsedSeconds}s)</span>
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
            <span className="size-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
            <span className="size-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
          </div>
        )}
      </div>
    </div>
  );
}
