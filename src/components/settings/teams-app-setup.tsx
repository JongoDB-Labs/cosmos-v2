"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, MessagesSquare } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";

/**
 * COSMOS-202 T1: for admins, on Integrations: what Cosmos for Teams needs, in
 * order. Shown once Outlook Calendar is set up (the Teams app answers for its
 * tenant and its connected people), or when the app is already installed.
 */

interface TeamsAppStatus {
  installed: boolean;
  calendarReady: boolean;
  appId: string | null;
  messagingEndpoint: string;
}

export function TeamsAppSetup({ orgId }: { orgId: string }) {
  const { data } = useQuery({
    queryKey: useOrgQueryKey("teams-app"),
    queryFn: () => jsonFetch<TeamsAppStatus>(`/api/v1/orgs/${orgId}/microsoft/teams-app`),
    retry: false,
  });
  if (!data || (!data.calendarReady && !data.installed)) return null;
  const copy = (v: string) =>
    void navigator.clipboard?.writeText(v).then(
      () => toast.success("Copied"),
      () => toast.error("Couldn't copy; select it and copy it."),
    );
  const code = (label: string, v: string) => (
    <span className="mt-1 flex items-center gap-2">
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{v}</code>
      <Button variant="ghost" size="sm" aria-label={`Copy ${label}`} onClick={() => copy(v)}>
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
  return (
    <SectionCard
      icon={MessagesSquare}
      title="Cosmos for Teams setup"
      description="Item link cards, Create Cosmos item from a message, and item search, inside Microsoft Teams."
    >
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          {data.calendarReady
            ? "Outlook Calendar is set up. Teams answers for its tenant, and for people who connected it."
            : "Set up Outlook Calendar first: Teams answers only for its tenant and the people who connected it."}
        </li>
        <li>
          {data.appId ? (
            <>
              In Azure, create an Azure Bot for the Microsoft app Cosmos signs in with:
              {code("app ID", data.appId)}
              set its messaging endpoint to:
              {code("messaging endpoint", data.messagingEndpoint)}
              and turn on its Microsoft Teams channel.
            </>
          ) : (
            "Configure the Microsoft sign-in app first (Admin, Sign-in providers). The bot uses the same app."
          )}
        </li>
        <li>{data.installed ? "Cosmos for Teams is installed." : "Install \"Cosmos for Teams\" below."}</li>
        <li>
          Upload the app package in the Teams admin center (Teams apps, Manage apps, Upload new app).
          {data.appId && (
            <span className="mt-1 block">
              <a href={`/api/v1/orgs/${orgId}/microsoft/teams-app/package`} download className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
                Download app package
              </a>
            </span>
          )}
        </li>
      </ol>
    </SectionCard>
  );
}
