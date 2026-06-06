"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreVertical } from "lucide-react";

type Pref = "ALL" | "MENTIONS" | "MUTED";
type Action = Pref | "MUTE_8H";

export function NotificationPrefMenu({
  orgId,
  channelId,
  current,
}: {
  orgId: string;
  channelId: string;
  current: Pref;
}) {
  const qc = useQueryClient();
  const channelsKey = useOrgQueryKey("chat-channels");

  async function setPref(action: Action) {
    const body =
      action === "MUTE_8H"
        ? { mutedUntil: new Date(Date.now() + 8 * 3600_000).toISOString() }
        : { notificationPref: action };
    try {
      const r = await fetch(
        `/api/v1/orgs/${orgId}/chat/channels/${channelId}/members/me`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) throw new Error("Couldn't update notification preference.");
      qc.invalidateQueries({ queryKey: channelsKey });
    } catch (err) {
      notifyError(err, "Couldn't update notification preference.");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Notification preferences"
            className="opacity-60 hover:opacity-100"
          />
        }
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={() => setPref("ALL")}>
          All messages {current === "ALL" ? "•" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setPref("MENTIONS")}>
          Mentions only {current === "MENTIONS" ? "•" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setPref("MUTED")}>
          Mute {current === "MUTED" ? "•" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setPref("MUTE_8H")}>
          Mute for 8h
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
