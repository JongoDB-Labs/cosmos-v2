"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Hash } from "lucide-react";
import { notifyError } from "@/lib/errors/notify";

type BrowseChannel = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  topic: string | null;
  lastMessageAt: string | null;
  _count: { members: number };
};

export function ChannelBrowseDialog({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const channelsKey = useOrgQueryKey("chat-channels");
  const browseKey = useOrgQueryKey("chat-channels-browse");
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: browseKey,
    enabled: open,
    queryFn: async () => {
      const r = await fetch(`/api/v1/orgs/${orgId}/chat/channels/browse`);
      if (!r.ok) throw new Error("Failed to load");
      const j = await r.json();
      return (j.channels ?? []) as BrowseChannel[];
    },
  });

  async function join(channelId: string) {
    try {
      const r = await fetch(
        `/api/v1/orgs/${orgId}/chat/channels/${channelId}/join`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error("Couldn't join the channel.");
      await qc.invalidateQueries({ queryKey: channelsKey });
      await qc.invalidateQueries({ queryKey: browseKey });
    } catch (err) {
      notifyError(err, "Couldn't join the channel.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 text-left"
          />
        }
      >
        + Browse channels
      </DialogTrigger>
      <DialogContent className="w-[28rem] max-w-[90vw]">
        <DialogTitle>Browse channels</DialogTitle>
        <div className="mt-2 max-h-80 overflow-y-auto divide-y">
          {isLoading && (
            <div className="text-sm text-muted-foreground p-3">Loading…</div>
          )}
          {!isLoading && isError && (
            <LoadError
              onRetry={() => {
                refetch();
              }}
            />
          )}
          {!isLoading && !isError && (data?.length ?? 0) === 0 && (
            <div className="text-sm text-muted-foreground p-3">
              No public channels to join.
            </div>
          )}
          {data?.map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-2">
              <Hash className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{c.name}</div>
                {c.description && (
                  <div className="text-xs text-muted-foreground truncate">
                    {c.description}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground">
                  {c._count.members} member{c._count.members === 1 ? "" : "s"}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => join(c.id)}>
                Join
              </Button>
            </div>
          ))}
        </div>
        <div className="flex justify-end mt-2">
          <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
