"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";

/**
 * For every member, on Profile: their own Slack link in this organization,
 * and which notifications go to Slack (both off is opted out). Hidden until
 * an admin connects Slack.
 */

type NotifyType = "assigned" | "mentioned";

interface MySlack {
  available: boolean;
  workspace: string | null;
  status: "LINKED" | "NEEDS_REVIEW" | "UNLINKED" | "NO_MATCH" | null;
  reason: "not_found" | "unconfirmed" | "conflict" | "unlinked" | "no_email" | null;
  notifyTypes: NotifyType[];
}

const CHOICES: { type: NotifyType; label: string }[] = [
  { type: "assigned", label: "An item is assigned to me" },
  { type: "mentioned", label: "I'm mentioned in a comment" },
];

function describe(d: MySlack): string {
  if (d.status === "LINKED") return `Linked to your account in ${d.workspace ?? "Slack"}, by your email address.`;
  if (d.status === "NEEDS_REVIEW") return "Your email matches a Slack account another member is already linked to. An admin has to allow it before anything is sent.";
  if (d.status === "UNLINKED") return "You unlinked Slack. Nothing is sent there until you link it again.";
  if (d.reason === "unconfirmed") return "Slack has your email address but you haven't confirmed it there. Confirm it in Slack, then link again.";
  if (d.status === "NO_MATCH") return `No account in ${d.workspace ?? "Slack"} has your Cosmos email address as a confirmed email.`;
  return "You'll be linked by your email address the first time a notification is due, or link now.";
}

export function SlackNotificationsSection({ orgId }: { orgId: string }) {
  const url = `/api/v1/orgs/${orgId}/slack/me`;
  const { data, isError } = useQuery({ queryKey: useOrgQueryKey("slack-me"), queryFn: () => jsonFetch<MySlack>(url), retry: false });
  const opts = (verb: string) => ({
    invalidate: [["slack-me"]],
    onError: (e: unknown) => notifyError(e, `Couldn't ${verb}.`),
  });
  const save = useOrgMutation({
    mutationFn: (notifyTypes: NotifyType[]) => jsonFetch<MySlack>(url, { method: "PUT", body: JSON.stringify({ notifyTypes }) }),
    onSuccess: () => toast.success("Slack notifications saved"),
    ...opts("save"),
  });
  const link = useOrgMutation({
    mutationFn: () => jsonFetch<MySlack>(url, { method: "POST" }),
    onSuccess: (r) => (r.status === "LINKED" ? toast.success("Slack linked") : toast.info(describe(r))),
    ...opts("link Slack"),
  });
  const unlink = useOrgMutation({
    mutationFn: () => jsonFetch<MySlack>(url, { method: "DELETE" }),
    onSuccess: () => toast.success("Slack unlinked"),
    ...opts("unlink Slack"),
  });

  // Slack isn't connected for this org: nothing to choose here.
  if (data && !data.available) return null;
  const chosen = new Set(data?.notifyTypes ?? []);
  const busy = save.isPending || link.isPending || unlink.isPending;

  return (
    <SectionCard icon={MessageSquare} title="Slack notifications" description="Get Cosmos notifications as direct messages in Slack.">
      {isError ? (
        <p className="text-sm text-muted-foreground">Couldn&apos;t load your Slack settings. Reload the page to try again.</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          Loading…
        </p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p role="status">{describe(data)}</p>
          <div>
            {data.status === "LINKED" || data.status === "NEEDS_REVIEW" ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => unlink.mutate()}>
                Unlink Slack
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => link.mutate()}>
                {data.status === null ? "Link my Slack account" : "Link again"}
              </Button>
            )}
          </div>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-medium">Send to Slack</legend>
            {CHOICES.map((c) => (
              <label key={c.type} className="flex items-center justify-between gap-3">
                <span>{c.label}</span>
                <ToggleSwitch
                  aria-label={c.label}
                  checked={chosen.has(c.type)}
                  disabled={busy}
                  onCheckedChange={(on) => save.mutate(CHOICES.map((x) => x.type).filter((t) => (t === c.type ? on : chosen.has(t))))}
                />
              </label>
            ))}
          </fieldset>
          {chosen.size === 0 && <p className="text-muted-foreground">Both are off, so nothing is sent to Slack.</p>}
          <p className="text-xs text-muted-foreground">
            Each message has the item&apos;s key and a link, and its title where your organization allows. Never its
            description or the comment.
          </p>
        </div>
      )}
    </SectionCard>
  );
}
