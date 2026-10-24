"use client";

import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/ui/section-card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";

/**
 * COSMOS-202 T2: which Cosmos notifications come to your chat with Cosmos in
 * Teams. Off until the org has Cosmos for Teams on, and nothing to choose
 * until you've opened that chat (Teams tells Cosmos where it is then).
 */

type NotifyType = "assigned" | "mentioned" | "due_tomorrow";

interface TeamsNotifications {
  available: boolean;
  chatReady: boolean;
  notifyTypes: NotifyType[];
}

const CHOICES: { type: NotifyType; label: string }[] = [
  { type: "assigned", label: "An item is assigned to me" },
  { type: "mentioned", label: "I'm mentioned in a comment" },
  { type: "due_tomorrow", label: "My items due tomorrow (each morning)" },
];

export function TeamsNotificationsSection({ orgId }: { orgId: string }) {
  const url = `/api/v1/orgs/${orgId}/microsoft/teams-app/notifications`;
  const { data } = useQuery({ queryKey: useOrgQueryKey("teams-notifications"), queryFn: () => jsonFetch<TeamsNotifications>(url) });
  const save = useOrgMutation({
    mutationFn: (notifyTypes: NotifyType[]) => jsonFetch<TeamsNotifications>(url, { method: "PUT", body: JSON.stringify({ notifyTypes }) }),
    invalidate: [["teams-notifications"]],
    onSuccess: () => toast.success("Teams notifications saved"),
    onError: (e) => notifyError(e, "Couldn't save."),
  });
  if (!data?.available) return null;
  const chosen = new Set(data.notifyTypes);

  return (
    <SectionCard icon={MessagesSquare} title="Teams notifications" description="Get Cosmos notifications in your chat with Cosmos in Microsoft Teams.">
      {!data.chatReady ? (
        <p className="text-sm text-muted-foreground">
          Open Cosmos in Teams (Apps, Cosmos) and send it a message, with Outlook Calendar connected above. Then choose
          what it sends you here.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {CHOICES.map((c) => (
            <label key={c.type} className="flex items-center justify-between gap-3 text-sm">
              <span>{c.label}</span>
              <ToggleSwitch
                aria-label={c.label}
                checked={chosen.has(c.type)}
                disabled={save.isPending}
                onCheckedChange={(on) => save.mutate(CHOICES.map((x) => x.type).filter((t) => (t === c.type ? on : chosen.has(t))))}
              />
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            Each message has the item&apos;s key, title and a link, never its description or comments. A restricted item
            shows only its key.
          </p>
        </div>
      )}
    </SectionCard>
  );
}
