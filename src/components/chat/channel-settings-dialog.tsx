"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Loader2, UserPlus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { jsonFetch, FetchError } from "@/lib/query/json-fetcher";
import { useOrgMembers } from "./mention-picker";
import { toast } from "sonner";
import type { ChatChannelSummary } from "@/hooks/use-chat-channels";

interface ChannelMemberRow {
  userId: string;
  role: "ADMIN" | "MEMBER";
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Channel settings — rename, set description/topic, and archive. The backing
 * PATCH already exists and is permission-gated (org/channel admin); the gear
 * that opens this is only shown when `channel.canManage` is true. #general
 * can't be archived (the server rejects it; we also hide the button).
 */
export function ChannelSettingsDialog({
  orgId,
  channel,
  open,
  onOpenChange,
}: {
  orgId: string;
  channel: ChatChannelSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const channelsKey = useOrgQueryKey("chat-channels");
  const router = useRouter();
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1] ?? "";

  const [name, setName] = useState(channel.name ?? "");
  const [description, setDescription] = useState(channel.description ?? "");
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const base = `/api/v1/orgs/${orgId}/chat/channels/${channel.id}`;
  const dirty =
    name.trim() !== (channel.name ?? "") ||
    description !== (channel.description ?? "") ||
    topic !== (channel.topic ?? "");

  // ── Members ──
  const membersKey = useOrgQueryKey("chat-channel-members", channel.id);
  const { data: members } = useQuery({
    queryKey: membersKey,
    queryFn: () => jsonFetch<ChannelMemberRow[]>(`${base}/members`),
    enabled: open,
  });
  const { data: orgMembers } = useOrgMembers(orgId);
  const [addUserId, setAddUserId] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);

  const memberIds = new Set((members ?? []).map((m) => m.userId));
  const addable = (orgMembers ?? []).filter((u) => !memberIds.has(u.id));

  async function addMember() {
    if (!addUserId) return;
    setMemberBusy(true);
    try {
      await jsonFetch(`${base}/members`, {
        method: "POST",
        body: JSON.stringify({ userIds: [addUserId] }),
      });
      setAddUserId("");
      await qc.invalidateQueries({ queryKey: membersKey });
    } catch (err) {
      notifyError(err, "Couldn't add the member.");
    } finally {
      setMemberBusy(false);
    }
  }

  async function removeMember(userId: string) {
    setMemberBusy(true);
    try {
      await jsonFetch(`${base}/members/${userId}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: membersKey });
    } catch (err) {
      notifyError(err, "Couldn't remove the member.");
    } finally {
      setMemberBusy(false);
    }
  }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await jsonFetch(base, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          topic: topic.trim() || null,
        }),
      });
      await qc.invalidateQueries({ queryKey: channelsKey });
      onOpenChange(false);
    } catch (err) {
      notifyError(err, "Couldn't save the channel settings.");
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    setArchiving(true);
    try {
      await jsonFetch(base, {
        method: "PATCH",
        body: JSON.stringify({ archive: true }),
      });
      await qc.invalidateQueries({ queryKey: channelsKey });
      toast.success(`Archived #${channel.name ?? "channel"}.`);
      onOpenChange(false);
      // The archived channel drops out of the list — leave its (now empty) view.
      router.push(`/${orgSlug}/chat`);
    } catch (err) {
      const msg =
        err instanceof FetchError && err.status === 400
          ? "#general can't be archived."
          : "Couldn't archive the channel.";
      notifyError(err, msg);
    } finally {
      setArchiving(false);
      setConfirmArchive(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && !archiving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Channel settings</DialogTitle>
          <DialogDescription>
            Rename the channel, set a description and topic, or archive it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="channel-name">Name</Label>
            <Input
              id="channel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              placeholder="channel-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="channel-topic">Topic</Label>
            <Input
              id="channel-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={256}
              placeholder="What's this channel about right now?"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="channel-description">Description</Label>
            <Textarea
              id="channel-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={512}
              rows={3}
              placeholder="Longer description (optional)"
            />
          </div>
        </div>

        {/* Members — list + add/remove. Private channels especially need this. */}
        <div className="space-y-2">
          <Label>Members ({members?.length ?? 0})</Label>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-1.5">
            {(members ?? []).map((m) => (
              <div
                key={m.userId}
                className="group/m flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/40"
              >
                <Avatar className="h-6 w-6">
                  <AvatarImage src={m.avatarUrl ?? undefined} />
                  <AvatarFallback className="text-[10px]">
                    {m.displayName.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
                {m.role === "ADMIN" && (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    Admin
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeMember(m.userId)}
                  disabled={memberBusy}
                  aria-label={`Remove ${m.displayName}`}
                  className="shrink-0 text-muted-foreground opacity-100 hover:text-destructive disabled:opacity-40 sm:opacity-0 sm:group-hover/m:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {members && members.length === 0 && (
              <p className="px-1.5 py-1 text-xs text-muted-foreground">No members yet.</p>
            )}
          </div>
          {addable.length > 0 && (
            <div className="flex items-center gap-2">
              <Select value={addUserId} onValueChange={(v) => setAddUserId(v ?? "")}>
                <SelectTrigger size="sm" aria-label="Add member" className="h-8 flex-1">
                  <SelectValue placeholder="Add a member…" />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={addMember}
                disabled={!addUserId || memberBusy}
                className="gap-1.5"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>
          )}
        </div>

        {/* Archive — destructive-ish, behind an inline confirm. Hidden for #general. */}
        {!channel.isGeneral && (
          <div className="rounded-md border border-destructive/30 p-3">
            {confirmArchive ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  Archive this channel? It hides from everyone&apos;s list.
                </span>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmArchive(false)}
                    disabled={archiving}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={archive}
                    disabled={archiving}
                  >
                    {archiving ? "Archiving…" : "Archive"}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmArchive(true)}
                className="flex items-center gap-1.5 text-sm text-destructive hover:underline"
              >
                <Archive className="h-3.5 w-3.5" />
                Archive channel
              </button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !name.trim() || !dirty}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
