"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Copy, Link2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { SectionCard } from "@/components/ui/section-card";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import type { FeedOptions } from "@/lib/calendar/feed-events";

/**
 * COSMOS-202: calendar subscription links. A person makes a link and pastes it
 * into Outlook ("Add calendar > Subscribe from web"), Google or Apple Calendar.
 * An org admin turns the feature on first: the calendar provider's servers
 * fetch the link, so whatever it shows leaves this system.
 */

interface FeedRow {
  id: string;
  options: FeedOptions;
  createdAt: string;
  lastFetchedAt: string | null;
}
interface FeedsResponse {
  enabled: boolean;
  canManage: boolean;
  feeds: FeedRow[];
}

const OPTION_LABELS: { key: keyof FeedOptions; label: string }[] = [
  { key: "workItems", label: "Work assigned to me (on its dates)" },
  { key: "meetings", label: "Meetings I attend" },
  { key: "intervals", label: "Sprints and PIs of my projects" },
  { key: "busyOnly", label: "Show as busy only (no titles or links)" },
];

function useFeeds(orgId: string) {
  return useQuery({
    queryKey: useOrgQueryKey("calendar-feeds"),
    queryFn: () => jsonFetch<FeedsResponse>(`/api/v1/orgs/${orgId}/calendar-feeds`),
  });
}

/** For everyone, on Preferences: make, tune and revoke your own links. */
export function CalendarFeedsSection({ orgId }: { orgId: string }) {
  const { data } = useFeeds(orgId);
  const base = `/api/v1/orgs/${orgId}/calendar-feeds`;
  // A new link's URL, shown once. It can't be fetched again: only its hash is kept.
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);

  const create = useOrgMutation({
    mutationFn: () => jsonFetch<FeedRow & { url: string }>(base, { method: "POST", body: JSON.stringify({}) }),
    invalidate: [["calendar-feeds"]],
    onSuccess: (f) => setFresh({ id: f.id, url: f.url }),
    onError: (e) => notifyError(e, "Couldn't create the link."),
  });
  const update = useOrgMutation({
    mutationFn: ({ id, options }: { id: string; options: FeedOptions }) =>
      jsonFetch(`${base}/${id}`, { method: "PATCH", body: JSON.stringify({ options }) }),
    invalidate: [["calendar-feeds"]],
    onError: (e) => notifyError(e, "Couldn't save that."),
  });
  const revoke = useOrgMutation({
    mutationFn: (id: string) => jsonFetch(`${base}/${id}`, { method: "DELETE" }),
    invalidate: [["calendar-feeds"]],
    onSuccess: (_r, id) => {
      if (fresh?.id === id) setFresh(null);
      toast.success("Link revoked");
    },
    onError: (e) => notifyError(e, "Couldn't revoke the link."),
  });

  return (
    <SectionCard
      icon={CalendarDays}
      title="Calendar feed"
      description="See your work and meetings in Outlook, Google Calendar or Apple Calendar."
    >
      {!data ? null : !data.enabled ? (
        <p className="text-sm text-muted-foreground">
          Your organization hasn&apos;t turned on calendar feeds.
          {data.canManage && " You can turn them on under Settings, Integrations."}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            Make a link, then in Outlook choose <strong>Add calendar, Subscribe from web</strong> and
            paste it. Treat the link like a password: anyone who has it sees what it shows. Revoke it
            here if it gets out. Restricted (marked) work always shows as busy only.
          </p>

          {fresh && (
            <div role="status" aria-label="New calendar link" className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3">
              <p className="text-xs font-medium">Copy this link now. It won&apos;t be shown again.</p>
              <div className="flex gap-2">
                <Input readOnly value={fresh.url} aria-label="Calendar link" onFocus={(e) => e.currentTarget.select()} />
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    void navigator.clipboard?.writeText(fresh.url).then(
                      () => toast.success("Link copied"),
                      () => toast.error("Couldn't copy; select the link and copy it."),
                    );
                  }}
                >
                  <Copy className="h-3.5 w-3.5" /> Copy
                </Button>
              </div>
            </div>
          )}

          {data.feeds.map((f, i) => (
            <div key={f.id} role="group" aria-label={`Calendar link ${i + 1}`} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  <Link2 className="mr-1 inline h-3.5 w-3.5" />
                  Link {i + 1}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {f.lastFetchedAt ? `last read by a calendar ${new Date(f.lastFetchedAt).toLocaleString()}` : "not read by a calendar yet"}
                  </span>
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-destructive hover:text-destructive"
                  onClick={() => revoke.mutate(f.id)}
                  disabled={revoke.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Revoke
                </Button>
              </div>
              {OPTION_LABELS.map((o) => (
                <label key={o.key} className="flex items-center justify-between gap-3 text-sm">
                  {o.label}
                  <ToggleSwitch
                    aria-label={o.label}
                    checked={f.options[o.key]}
                    onCheckedChange={(v) => update.mutate({ id: f.id, options: { ...f.options, [o.key]: v } })}
                  />
                </label>
              ))}
            </div>
          ))}

          <div>
            <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
              {data.feeds.length ? "Make another link" : "Make a calendar link"}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/** For admins, on Integrations: the org switch. */
export function CalendarFeedsOrgSwitch({ orgId }: { orgId: string }) {
  const { data } = useFeeds(orgId);
  const toggle = useOrgMutation({
    mutationFn: (enabled: boolean) =>
      jsonFetch(`/api/v1/orgs/${orgId}/calendar-feeds/settings`, { method: "PUT", body: JSON.stringify({ enabled }) }),
    invalidate: [["calendar-feeds"]],
    onError: (e) => notifyError(e, "Couldn't change the setting."),
  });
  if (!data?.canManage) return null;
  return (
    <SectionCard
      icon={CalendarDays}
      title="Calendar feeds"
      description="Let people subscribe to their work and meetings from Outlook, Google or Apple Calendar."
    >
      <label className="flex items-start justify-between gap-4 text-sm">
        <span>
          Allow calendar feed links
          <span className="mt-0.5 block text-xs text-muted-foreground">
            The calendar provider fetches each link from its own servers, so titles in a feed leave
            this system. Restricted (marked) work is always shown as busy only. Turning this off stops
            every existing link at once.
          </span>
        </span>
        <ToggleSwitch
          aria-label="Allow calendar feed links"
          checked={data.enabled}
          onCheckedChange={(v) => toggle.mutate(v)}
          disabled={toggle.isPending}
        />
      </label>
    </SectionCard>
  );
}
