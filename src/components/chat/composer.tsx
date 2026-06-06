"use client";
import { useRef, useState } from "react";
import { Send, Paperclip, X } from "lucide-react";
import { MentionPicker, useOrgMembers } from "./mention-picker";
import { SlashCommandMenu } from "./slash-command-menu";
import type { ChatMessageAttachmentDto } from "@/hooks/use-chat-messages";
import { parseSlash, getCommand } from "@/lib/chat/commands";
import type { SlashCommand } from "@/lib/chat/commands";

export function Composer({
  orgId,
  channelLabel,
  onSend,
  onTyping,
  canManage,
  onCommand,
  onHelp,
  onDm,
}: {
  orgId: string;
  channelLabel: string;
  onSend: (content: string, attachmentIds: string[], kind?: "USER" | "ACTION") => void;
  onTyping?: () => void;
  canManage: boolean;
  onCommand: (command: string, args: string) => void | Promise<void>;
  onHelp: () => void;
  onDm: (mentionText: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<ChatMessageAttachmentDto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [mentionState, setMentionState] = useState<{
    q: string;
    anchor: { top: number; left: number };
  } | null>(null);
  const [slashState, setSlashState] = useState<{
    prefix: string;
    anchor: { top: number; left: number };
  } | null>(null);
  const { data: members } = useOrgMembers(orgId);

  async function upload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/v1/orgs/${orgId}/chat/attachments`, {
        method: "POST",
        body: fd,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        setUploadError(body?.error ?? `Upload failed (${r.status})`);
        return null;
      }
      const att = (await r.json()) as ChatMessageAttachmentDto;
      setPending((prev) => [...prev, att]);
      return att;
    } finally {
      setUploading(false);
    }
  }

  async function uploadMany(files: FileList | File[]) {
    const arr = Array.from(files);
    for (const f of arr) {
      // Cap pending at 10
      if (pending.length >= 10) {
        setUploadError("Max 10 attachments per message");
        break;
      }
      await upload(f);
    }
  }

  function removePending(id: string) {
    setPending((prev) => prev.filter((a) => a.id !== id));
  }

  function detectMention(text: string, caret: number) {
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)@([\w-]*)$/);
    if (!m) return null;
    return m[1];
  }

  /** Detect if the textarea value starts with a slash and the caret is within
   *  the first token (no space yet typed). Returns the prefix after the slash,
   *  or null if not in slash mode. */
  function detectSlash(text: string, caret: number): string | null {
    // Only trigger when the slash is the very first character
    if (!text.startsWith("/")) return null;
    const before = text.slice(0, caret);
    // If we've already typed a space, the first token is complete — hide menu
    const firstSpace = before.indexOf(" ");
    if (firstSpace !== -1) return null;
    return before.slice(1); // prefix after the leading "/"
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const newValue = e.target.value;
    setValue(newValue);
    onTyping?.();

    const caret = e.target.selectionStart ?? 0;

    // Slash detection takes priority — suppress mention menu while active
    const slash = detectSlash(newValue, caret);
    if (slash !== null) {
      const rect = e.target.getBoundingClientRect();
      setSlashState({
        prefix: slash,
        anchor: { top: rect.top - 8 - 200, left: rect.left },
      });
      setMentionState(null);
      return;
    }
    setSlashState(null);

    // Mention detection (only when not in slash mode)
    const q = detectMention(newValue, caret);
    if (q !== null) {
      const rect = e.target.getBoundingClientRect();
      setMentionState({
        q,
        anchor: { top: rect.top - 8 - 200, left: rect.left + 32 },
      });
    } else {
      setMentionState(null);
    }
  }

  function send() {
    if (slashState) return;
    const text = value.trim();
    if (!text && pending.length === 0) return;

    // Classify slash commands before the normal send path
    const slash = text ? parseSlash(text) : null;
    if (slash && slash.known) {
      const cmd = getCommand(slash.command);
      if (cmd) {
        if (cmd.handledBy === "server") {
          void onCommand(slash.command, slash.args);
          setValue("");
          setPending([]);
          setSlashState(null);
          return;
        }
        if (slash.command === "help") {
          onHelp();
          setValue("");
          setSlashState(null);
          return;
        }
        if (slash.command === "dm") {
          onDm(slash.args);
          setValue("");
          setSlashState(null);
          return;
        }
        if (slash.command === "me") {
          if (!slash.args) return;             // ignore empty /me
          onSend(slash.args, [], "ACTION");
          setValue("");
          setPending([]);
          setSlashState(null);
          return;
        }
        if (slash.command === "shrug") {
          onSend(
            `${slash.args} ¯\\_(ツ)_/¯`.trim(),
            pending.map((a) => a.id),
          );
          setValue("");
          setPending([]);
          setSlashState(null);
          return;
        }
      }
    }

    // Normal send path
    onSend(text, pending.map((a) => a.id));
    setValue("");
    setPending([]);
    setUploadError(null);
    setSlashState(null);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Let the slash menu's own window keydown handler consume Enter/Arrows/Tab/Escape
    if (slashState) return;
    if (mentionState) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function pickMention(user: { id: string; displayName: string }) {
    const ta = ref.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? value.length;
    const before = value
      .slice(0, caret)
      .replace(/(?:^|\s)@([\w-]*)$/, (m) => m.replace(/@[\w-]*$/, `<@${user.id}>`));
    const after = value.slice(caret);
    setValue(before + after);
    setMentionState(null);
    requestAnimationFrame(() => ta.focus());
  }

  function pickSlash(cmd: SlashCommand) {
    const ta = ref.current;
    const newValue = `/${cmd.name} `;
    setValue(newValue);
    setSlashState(null);
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newValue.length, newValue.length);
      }
    });
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData.files;
    if (files && files.length > 0) {
      e.preventDefault();
      void uploadMany(files);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void uploadMany(e.dataTransfer.files);
    }
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
  }

  return (
    <div
      className="border-t p-3 shrink-0"
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      {(pending.length > 0 || uploading || uploadError) && (
        <div className="mb-2 flex flex-wrap gap-1">
          {pending.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 rounded border bg-muted px-2 py-0.5 text-xs"
            >
              <span className="truncate max-w-[160px]">{a.filename}</span>
              <button
                type="button"
                onClick={() => removePending(a.id)}
                aria-label={`Remove ${a.filename}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {uploading && (
            <span className="text-xs text-muted-foreground">Uploading…</span>
          )}
          {uploadError && (
            <span className="text-xs text-destructive">{uploadError}</span>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void uploadMany(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Attach"
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <textarea
          ref={ref}
          rows={1}
          placeholder={`Message ${channelLabel}…`}
          className="flex-1 resize-none bg-background border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          value={value}
          onChange={onChange}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        <button
          type="button"
          className="text-primary disabled:text-muted-foreground"
          disabled={!value.trim() && pending.length === 0}
          onClick={send}
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
      {slashState && (
        <SlashCommandMenu
          prefix={slashState.prefix}
          canManage={canManage}
          anchor={slashState.anchor}
          onPick={pickSlash}
          onCancel={() => setSlashState(null)}
        />
      )}
      {mentionState && members && (
        <MentionPicker
          query={mentionState.q}
          anchor={mentionState.anchor}
          members={members}
          onPick={pickMention}
          onCancel={() => setMentionState(null)}
        />
      )}
    </div>
  );
}
