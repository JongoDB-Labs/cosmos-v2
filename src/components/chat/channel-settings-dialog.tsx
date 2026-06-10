"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Loader2 } from "lucide-react";
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
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { jsonFetch, FetchError } from "@/lib/query/json-fetcher";
import { toast } from "sonner";
import type { ChatChannelSummary } from "@/hooks/use-chat-channels";

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
