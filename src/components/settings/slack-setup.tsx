"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, MessageSquare } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { LocalTimestamp } from "@/components/ui/local-timestamp";
import { SectionCard } from "@/components/ui/section-card";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";

/**
 * For admins, on Integrations: connect the org's Slack workspace ("Add to
 * Slack"), see whether messages are getting through, and look after members'
 * links. Members choose their own on Profile.
 */

type LinkStatus = "LINKED" | "NEEDS_REVIEW" | "UNLINKED" | "NO_MATCH";

interface SlackSetupData {
  appConfigured: boolean;
  redirectUri: string;
  scopes: string[];
  installation: {
    teamId: string;
    teamName: string;
    installedBy: string | null;
    status: "ACTIVE" | "ERROR";
    lastDeliveredAt: string | null;
    lastErrorAt: string | null;
    lastErrorCode: string | null;
    queued: number;
    linkOrigin: string;
  } | null;
  links: { id: string; userId: string; name: string; email: string; status: LinkStatus; slackUserId: string | null; approved: boolean; optedOut: boolean }[];
}

const STATUS: Record<LinkStatus, { label: string; variant: BadgeVariant }> = {
  LINKED: { label: "Linked", variant: "done" },
  NEEDS_REVIEW: { label: "Shares a Slack account", variant: "review" },
  UNLINKED: { label: "Unlinked by choice", variant: "neutral" },
  NO_MATCH: { label: "Not matched", variant: "neutral" },
};

/** What the page says when Slack sends the admin back here (?slack=…). */
const OUTCOMES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Slack is connected. Members are matched by email the first time a notification is due, or use Match members by email now." },
  denied: { ok: false, text: "Slack wasn't connected: the install was cancelled in Slack." },
  forbidden: { ok: false, text: "Slack wasn't connected: you need permission to manage integrations." },
  not_configured: { ok: false, text: "Slack wasn't connected: this Cosmos instance has no Slack app yet. See the steps below." },
  enterprise_install: { ok: false, text: "Slack wasn't connected: install the app into one workspace. Organization-wide Enterprise Grid installs aren't supported." },
  missing_scopes: { ok: false, text: "Slack wasn't connected: the Slack app is missing a permission. Check its bot token scopes against the list below." },
  extra_scopes: { ok: false, text: "Slack wasn't connected: the Slack app has more permissions than Cosmos uses. Remove the extra bot token scopes so it has exactly the ones below." },
  workspace_taken: { ok: false, text: "This Slack workspace is already connected to another Cosmos organization. Disconnect it there first." },
  rate_limited: { ok: false, text: "Slack wasn't connected: too many tries. Wait a minute and try again." },
  failed: { ok: false, text: "Slack wasn't connected: Slack didn't accept the install. Try again; if it keeps failing, check the app's client ID, secret and redirect URL." },
};

function useLandingParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(new URLSearchParams(window.location.search).get(name));
  }, [name]);
  return value;
}

export function SlackSetup({ orgId }: { orgId: string }) {
  const url = `/api/v1/orgs/${orgId}/slack`;
  const { data, isError, refetch } = useQuery({ queryKey: useOrgQueryKey("slack-setup"), queryFn: () => jsonFetch<SlackSetupData>(url), retry: false });
  const outcome = OUTCOMES[useLandingParam("slack") ?? ""];
  const match = useOrgMutation({
    mutationFn: () => jsonFetch<{ linked: number; review: number; notFound: number; remaining: number }>(`${url}/links`, { method: "POST" }),
    invalidate: [["slack-setup"]],
    onSuccess: (r) =>
      toast.success(
        `Linked ${r.linked}, ${r.review} waiting for you, ${r.notFound} not found in Slack${r.remaining ? `; ${r.remaining} left, run it again in a minute` : ""}.`,
      ),
    onError: (e) => notifyError(e, "Couldn't match members."),
  });
  const update = useOrgMutation({
    mutationFn: (v: { linkId: string; action: "approve" | "unlink" }) =>
      jsonFetch(`${url}/links/${v.linkId}`, { method: "PATCH", body: JSON.stringify({ action: v.action }) }),
    invalidate: [["slack-setup"]],
    onSuccess: (_r, v) => toast.success(v.action === "approve" ? "Link allowed" : "Link removed"),
    onError: (e) => notifyError(e, "Couldn't change the link."),
  });
  const disconnect = useOrgMutation({
    mutationFn: () => jsonFetch<{ revoked: boolean; revokeError: string | null }>(url, { method: "DELETE" }),
    invalidate: [["slack-setup"], ["slack-me"]],
    onSuccess: (r) =>
      r.revoked
        ? toast.success("Slack disconnected")
        : toast.warning(`Slack disconnected here, but Slack didn't confirm the token was revoked (${r.revokeError}). Remove the app from the workspace in Slack too.`),
    onError: (e) => notifyError(e, "Couldn't disconnect."),
  });

  const copy = (v: string) =>
    void navigator.clipboard?.writeText(v).then(
      () => toast.success("Copied"),
      () => toast.error("Couldn't copy; select it and copy it."),
    );
  const code = (label: string, v: string) => (
    <span className="mt-1 flex items-center gap-2">
      <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">{v}</code>
      <Button variant="ghost" size="sm" aria-label={`Copy ${label}`} onClick={() => copy(v)}>
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
  const addToSlack = (label: string) => (
    <a href={`${url}/install`} className={cn(buttonVariants({ size: "sm", variant: label === "Add to Slack" ? "default" : "outline" }))}>
      {label}
    </a>
  );

  const i = data?.installation;
  return (
    <SectionCard
      icon={MessageSquare}
      title="Slack notifications"
      description="Sends assignments and @mentions to members as direct messages in your Slack workspace."
    >
      <div className="flex flex-col gap-4 text-sm">
        {outcome && (
          <p role="status" className={cn("rounded-md border px-3 py-2", outcome.ok ? "border-[var(--status-done)]" : "border-[var(--status-blocked)]")}>
            {outcome.text}
          </p>
        )}
        {isError ? (
          <p className="text-muted-foreground">
            Couldn&apos;t load Slack&apos;s settings.{" "}
            <Button variant="link" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </p>
        ) : !data ? (
          <p className="text-muted-foreground" aria-busy="true">
            Loading…
          </p>
        ) : !data.appConfigured && !i ? (
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Your Cosmos administrator creates a Slack app for this instance, from the manifest in the Slack
              notifications runbook, with this redirect URL:
              {code("redirect URL", data.redirectUri)}
            </li>
            <li>
              They set <code className="rounded bg-muted px-1 text-xs">SLACK_CLIENT_ID</code> and{" "}
              <code className="rounded bg-muted px-1 text-xs">SLACK_CLIENT_SECRET</code> to the app&apos;s client ID and
              secret, and restart Cosmos.
            </li>
            <li>Then you can add it to your workspace here.</li>
          </ol>
        ) : !i ? (
          <div className="flex flex-col gap-2">
            <p>
              Add the app to your Slack workspace. Slack asks you to allow it to send messages, open a direct message,
              and find members by email, and nothing else (
              <code className="rounded bg-muted px-1 text-xs">{data.scopes.join(", ")}</code>).
            </p>
            <div>{addToSlack("Add to Slack")}</div>
          </div>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Workspace</dt>
              <dd>
                {i.teamName || i.teamId}
                {i.installedBy && <span className="text-muted-foreground"> (added by {i.installedBy})</span>}
              </dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                {i.status === "ACTIVE" ? (
                  <Badge variant="done">Working</Badge>
                ) : (
                  <Badge variant="blocked">Not sending: reconnect Slack</Badge>
                )}
              </dd>
              <dt className="text-muted-foreground">Last message sent</dt>
              <dd>
                <LocalTimestamp value={i.lastDeliveredAt} fallback="None yet" />
              </dd>
              <dt className="text-muted-foreground">Last problem</dt>
              <dd>
                {i.lastErrorCode ? (
                  <>
                    <code className="rounded bg-muted px-1 text-xs">{i.lastErrorCode}</code>{" "}
                    <span className="text-muted-foreground">
                      <LocalTimestamp value={i.lastErrorAt} />
                    </span>
                  </>
                ) : (
                  "None"
                )}
              </dd>
              <dt className="text-muted-foreground">Waiting to send</dt>
              <dd>{i.queued}</dd>
              <dt className="text-muted-foreground">Links open</dt>
              <dd className="break-all">{i.linkOrigin}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">
              Each message has the item&apos;s key and a link. It has the title only if this organization lets titles go
              out by email (Organization, Query language, Include titles in filter emails), and never for a restricted
              item. Cosmos checks the person can still open the item when it sends.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={match.isPending || i.status !== "ACTIVE"} onClick={() => match.mutate()}>
                Match members by email
              </Button>
              {addToSlack("Reconnect")}
              <ConfirmButton size="sm" pending={disconnect.isPending} confirmLabel="Disconnect Slack" onConfirm={() => disconnect.mutate()}>
                Disconnect
              </ConfirmButton>
            </div>
            <MemberLinks links={data.links} pending={update.isPending} onAction={(linkId, action) => update.mutate({ linkId, action })} />
          </>
        )}
      </div>
    </SectionCard>
  );
}

function MemberLinks({
  links,
  pending,
  onAction,
}: {
  links: SlackSetupData["links"];
  pending: boolean;
  onAction: (linkId: string, action: "approve" | "unlink") => void;
}) {
  if (links.length === 0) {
    return <p className="text-muted-foreground">No members matched yet.</p>;
  }
  const waiting = links.filter((l) => l.status === "NEEDS_REVIEW").length;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">Members</h3>
      <p className="text-xs text-muted-foreground">
        Not matched: Slack has no account in this workspace with the member&apos;s Cosmos email as a confirmed email.
      </p>
      {waiting > 0 && (
        <p>
          {waiting === 1 ? "One member shares" : `${waiting} members share`} a Slack account with another member. Nothing
          is sent to them until you allow it. If you allow it, whoever owns that Slack account gets this member&apos;s
          notifications. You can&apos;t allow your own.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <caption className="sr-only">Members&apos; Slack links</caption>
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-3 font-normal">Member</th>
              <th scope="col" className="py-1 pr-3 font-normal">Slack</th>
              <th scope="col" className="py-1 font-normal"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id} className="border-t">
                <td className="py-2 pr-3">
                  <div>{l.name}</div>
                  <div className="text-xs text-muted-foreground">{l.email}</div>
                </td>
                <td className="py-2 pr-3">
                  <Badge variant={STATUS[l.status].variant}>{STATUS[l.status].label}</Badge>
                  {l.slackUserId && <code className="ml-2 rounded bg-muted px-1 text-xs">{l.slackUserId}</code>}
                  {l.optedOut && <span className="ml-2 text-xs text-muted-foreground">(turned off)</span>}
                </td>
                <td className="py-2 text-right">
                  <span className="inline-flex gap-1">
                    {l.status === "NEEDS_REVIEW" && (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction(l.id, "approve")} aria-label={`Allow ${l.name}'s link`}>
                        Allow
                      </Button>
                    )}
                    {(l.status === "LINKED" || l.status === "NEEDS_REVIEW") && (
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => onAction(l.id, "unlink")} aria-label={`Remove ${l.name}'s link`}>
                        Remove
                      </Button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
