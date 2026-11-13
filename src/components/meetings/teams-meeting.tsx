"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Video } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey, useOrgSlug } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { TEAMS_REFUSED, TEAMS_STATUS, type TeamsRefusal } from "@/lib/meetings/teams-messages";

/**
 * A Cosmos meeting as a Teams meeting: made in one person's own Outlook (the
 * host), its join link shown to everyone who can see the meeting. Shows
 * nothing while the org has Outlook Calendar off and it isn't one.
 */

export interface TeamsState {
  available: boolean;
  on: boolean;
  hostId: string | null;
  hostName: string | null;
  isHost: boolean;
  joinUrl: string | null;
  status: "ready" | "pending" | "no_join_url" | "host_not_connected" | "host_reconnect" | null;
  canChange: boolean;
  reason: TeamsRefusal | null;
}

/** The "Join Teams meeting" link: a new tab, never inside another control. */
export function TeamsJoinLink({ url, size = "sm", className }: { url: string; size?: "sm" | "xs"; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(buttonVariants({ size, variant: "outline" }), className)}
    >
      <Video className="size-4" aria-hidden />
      Join Teams meeting
    </a>
  );
}

/** `onChange`: the meeting's Teams state changed here (so the page can show the link). */
export function TeamsMeetingPanel({
  orgId,
  meetingId,
  version = 0,
  onChange,
}: {
  orgId: string;
  meetingId: string;
  version?: number;
  onChange?: (s: TeamsState) => void;
}) {
  const slug = useOrgSlug();
  const url = `/api/v1/orgs/${orgId}/meetings/${meetingId}/teams`;
  const { data } = useQuery({
    queryKey: useOrgQueryKey("meeting-teams", meetingId, version),
    queryFn: () => jsonFetch<TeamsState>(url),
  });
  // Turning it off ends the Teams meeting: asked first, in place.
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [focusTo, setFocusTo] = useState<"review" | "switch" | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const switchRef = useRef<HTMLDivElement>(null);
  const toggle = useOrgMutation({
    mutationFn: (enabled: boolean) =>
      jsonFetch<TeamsState>(url, { method: "PUT", body: JSON.stringify({ enabled }) }),
    // The invitation panel's answer depends on who hosts Teams, and the other way round.
    invalidate: [["meeting-teams", meetingId], ["outlook-invite", meetingId]],
    onSuccess: (d, enabled) => {
      setConfirmingOff(false);
      setFocusTo("switch");
      if (d) onChange?.(d);
      if (!enabled) return void toast.success("Teams meeting turned off");
      // On, but no link: say so plainly; the meeting itself saved fine.
      if (d?.joinUrl) toast.success("Teams meeting added");
      else toast.message("Teams is on for this meeting, but there's no join link yet.");
    },
    onError: (e) => notifyError(e, "Couldn't change the Teams meeting."),
  });

  useEffect(() => {
    if (!focusTo) return;
    const el = focusTo === "review" ? reviewRef.current : switchRef.current?.querySelector<HTMLElement>("[role=switch]");
    if (!el) return;
    el.focus();
    setFocusTo(null);
  }, [focusTo, data, confirmingOff]);

  if (!data || (!data.available && !data.on)) return null;
  const hostText = data.isHost ? "your" : data.hostName ? `${data.hostName}'s` : "the host's";
  const reasonText = data.reason && data.reason !== "not_found" ? TEAMS_REFUSED[data.reason][1] : null;

  return (
    <>
      <Separator />
      <section aria-labelledby="teams-meeting-heading" className="flex flex-col gap-3">
        <div ref={switchRef} className="flex items-center justify-between gap-3">
          <h2 id="teams-meeting-heading" className="flex items-center gap-2 text-lg font-semibold">
            <Video className="size-5" aria-hidden />
            Teams meeting
          </h2>
          <ToggleSwitch
            aria-label="Teams meeting"
            checked={data.on}
            disabled={!data.canChange || toggle.isPending || confirmingOff}
            onCheckedChange={(v) => {
              if (v) toggle.mutate(true);
              else {
                setConfirmingOff(true);
                setFocusTo("review");
              }
            }}
          />
        </div>

        {data.on ? (
          <>
            <p className="text-sm text-muted-foreground">
              The Teams meeting is in {hostText} Outlook. Everyone who can see this meeting sees its join link.
            </p>
            {data.joinUrl ? (
              <div>
                <TeamsJoinLink url={data.joinUrl} />
              </div>
            ) : data.status && data.status !== "ready" ? (
              <p role="status" className="text-sm text-muted-foreground">
                {TEAMS_STATUS[data.status]}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Make this a Teams meeting. It&apos;s made in your Outlook, and everyone who can see this meeting gets the join link.
          </p>
        )}

        {reasonText && (data.on ? data.reason !== "cannot_edit" : true) && (
          <p className="text-sm text-muted-foreground">
            {reasonText}
            {(data.reason === "not_connected" || data.reason === "reconnect") && slug && (
              <>
                {" "}
                <Link href={`/${slug}/settings/preferences`} className="underline">
                  Outlook Calendar settings
                </Link>
              </>
            )}
          </p>
        )}

        {confirmingOff && (
          <div
            ref={reviewRef}
            tabIndex={-1}
            role="group"
            aria-label="Turn off the Teams meeting"
            className="flex flex-col gap-2 rounded-md border p-3 outline-none"
          >
            <p className="text-sm">
              The Teams meeting is deleted from {hostText} Outlook, and its join link stops working for everyone.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => toggle.mutate(false)} disabled={toggle.isPending}>
                Turn off Teams meeting
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={toggle.isPending}
                onClick={() => {
                  setConfirmingOff(false);
                  setFocusTo("switch");
                }}
              >
                Keep it
              </Button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
