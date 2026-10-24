"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey, useOrgSlug } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";

/**
 * COSMOS-202 B2 invite mode: the meeting's organizer sends real Outlook
 * invitations from their own calendar, instead of each attendee getting a
 * copy in their "Cosmos" calendar. Shows nothing while the org has Outlook
 * Calendar off.
 */

interface InviteState {
  available: boolean;
  on: boolean;
  organizerId: string | null;
  organizerName: string | null;
  canChange: boolean;
  reason:
    | "classified"
    | "not_connected"
    | "reconnect"
    | "cannot_edit"
    | "too_many_attendees"
    | "cancelled"
    | null;
  recipients: { name: string; email: string; outside: boolean }[];
  /** Its cancellation is waiting for the organizer to reconnect Outlook. */
  pendingCancel: boolean;
  domains: string[];
  ended: {
    how: "released" | "cancelled";
    reason: string | null;
    at: string;
  } | null;
}

const WHY_NOT: Record<NonNullable<InviteState["reason"]>, string> = {
  classified:
    "Classified meetings can't send Outlook invitations; they appear in Outlook only as busy.",
  not_connected: "Connect your Outlook Calendar to send invitations.",
  reconnect: "Reconnect your Outlook Calendar to send invitations.",
  cannot_edit:
    "Only someone who can edit this meeting can send its invitations.",
  too_many_attendees: "Outlook invitations are limited to 100 attendees.",
  cancelled: "This meeting is cancelled.",
};

const WHY_ENDED: Record<string, string> = {
  turned_off: "they were turned off",
  classified: "the meeting became classified",
  organizer_cannot_edit: "their organizer can no longer edit the meeting",
  too_many_attendees: "the meeting has more than 100 attendees",
  organizer_not_connected: "their organizer's Outlook Calendar isn't connected",
  organizer_disconnected: "their organizer disconnected Outlook Calendar",
  organizer_left: "their organizer left the organization",
  organizer_deactivated: "their organizer's account was deactivated",
  integration_disabled: "Outlook Calendar was turned off for the organization",
  tenant_changed: "the organization's Microsoft tenant changed",
  meeting_gone: "the meeting was deleted",
};

function endedText(e: NonNullable<InviteState["ended"]>): string {
  const why = e.reason && WHY_ENDED[e.reason];
  return e.how === "released"
    ? `Earlier Outlook invitations for this meeting were left in Outlook${why ? ` when ${why}` : ""}. Cosmos no longer updates them; change or cancel them in Outlook.`
    : `Outlook invitations for this meeting were cancelled${why ? ` because ${why}` : ""}. Attendees were sent a cancellation.`;
}

/** `version`: bump to refetch after the meeting changes (attendees, time). */
export function OutlookInvitePanel({
  orgId,
  meetingId,
  version = 0,
}: {
  orgId: string;
  meetingId: string;
  version?: number;
}) {
  const slug = useOrgSlug();
  const url = `/api/v1/orgs/${orgId}/meetings/${meetingId}/outlook-invite`;
  const { data } = useQuery({
    queryKey: useOrgQueryKey("outlook-invite", meetingId, version),
    queryFn: () => jsonFetch<InviteState>(url),
  });
  // "on" / "off": the person is reviewing what turning it on or off will do.
  const [confirming, setConfirming] = useState<"on" | "off" | null>(null);
  // Each step replaces the button that was just used, so keyboard focus is
  // moved on purpose rather than dropped on the page: into the review when it
  // opens, back to its button when it's put away, to the heading once done.
  const [focusTo, setFocusTo] = useState<"review" | "start" | "stop" | "heading" | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const open = (step: "on" | "off") => {
    setConfirming(step);
    setFocusTo("review");
  };
  const putAway = () => {
    setFocusTo(confirming === "off" ? "stop" : "start");
    setConfirming(null);
  };
  const toggle = useOrgMutation({
    mutationFn: (enabled: boolean) =>
      jsonFetch<InviteState>(url, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    invalidate: [["outlook-invite", meetingId]],
    onSuccess: (d, enabled) => {
      setConfirming(null);
      setFocusTo("heading");
      if (!enabled && d?.pendingCancel) {
        toast.error("Reconnect Outlook Calendar to cancel the invitations.");
        return;
      }
      toast.success(
        enabled ? "Outlook invitations sent" : "Outlook invitations cancelled",
      );
    },
    onError: (e) => notifyError(e, "Couldn't change the Outlook invitations."),
  });

  useEffect(() => {
    if (!focusTo) return;
    const el = { review: reviewRef, start: startRef, stop: stopRef, heading: headingRef }[focusTo].current;
    if (!el) return; // not rendered yet (the refetch after a change): try again on the next render
    el.focus();
    setFocusTo(null);
  }, [focusTo, data, confirming]);

  if (!data || (!data.available && !data.on && !data.ended)) return null;
  const outside = data.recipients.filter((r) => r.outside);
  const mine = data.on && data.organizerId !== null && data.canChange;

  return (
    <>
      <Separator />
      <section
        aria-labelledby="outlook-invite-heading"
        className="flex flex-col gap-3"
      >
        <h2
          id="outlook-invite-heading"
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-2 text-lg font-semibold outline-none"
        >
          <CalendarCheck className="size-5" />
          Outlook invitations
        </h2>

        {data.ended && !data.on && (
          <p role="note" className="text-sm text-muted-foreground">
            {endedText(data.ended)}
          </p>
        )}

        {data.on ? (
          <>
            <p className="text-sm">
              Invitations are sent from{" "}
              {data.organizerName ? (
                <strong>{data.organizerName}</strong>
              ) : (
                "the organizer"
              )}
              &apos;s Outlook calendar. Attendees get an update in Outlook when
              this meeting changes, instead of a copy in their
              &quot;Cosmos&quot; calendar.
            </p>
            {data.pendingCancel && (
              <p role="alert" className="text-sm text-[var(--status-critical-text)]">
                {mine
                  ? "These invitations couldn't be cancelled: reconnect your Outlook Calendar (Settings, Preferences) and they will be."
                  : "These invitations are waiting to be cancelled until the organizer reconnects Outlook."}
              </p>
            )}
            {mine && !data.pendingCancel && confirming !== "off" && (
              <div>
                <Button
                  ref={stopRef}
                  size="sm"
                  variant="outline"
                  onClick={() => open("off")}
                >
                  Stop sending invitations
                </Button>
              </div>
            )}
            {confirming === "off" && (
              <div
                ref={reviewRef}
                tabIndex={-1}
                role="group"
                aria-label="Stop Outlook invitations"
                className="flex flex-col gap-2 rounded-md border p-3 outline-none"
              >
                <p className="text-sm">
                  Attendees will be sent a cancellation in Outlook, and the
                  meeting goes back into each person&apos;s &quot;Cosmos&quot;
                  calendar.
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => toggle.mutate(false)}
                    disabled={toggle.isPending}
                  >
                    Cancel the invitations
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={putAway}
                    disabled={toggle.isPending}
                  >
                    Keep sending
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : !data.available ? null : (
          <>
            <p className="text-sm text-muted-foreground">
              Send real Outlook invitations from your calendar, so attendees can
              accept them and get updates.
            </p>
            {data.reason ? (
              <p className="text-sm text-muted-foreground">
                {WHY_NOT[data.reason]}
                {(data.reason === "not_connected" ||
                  data.reason === "reconnect") &&
                  slug && (
                    <>
                      {" "}
                      <Link
                        href={`/${slug}/settings/preferences`}
                        className="underline"
                      >
                        Outlook Calendar settings
                      </Link>
                    </>
                  )}
              </p>
            ) : null}
            {confirming !== "on" && (
              <div>
                <Button
                  ref={startRef}
                  size="sm"
                  variant="outline"
                  onClick={() => open("on")}
                  disabled={!data.canChange}
                >
                  Send Outlook invitations
                </Button>
              </div>
            )}
            {confirming === "on" && (
              <div
                ref={reviewRef}
                tabIndex={-1}
                role="group"
                aria-label="Send Outlook invitations"
                className="flex flex-col gap-2 rounded-md border p-3 outline-none"
              >
                {data.recipients.length ? (
                  <>
                    <p className="text-sm">
                      These people will get an invitation from your Outlook
                      calendar:
                    </p>
                    <ul className="flex flex-col gap-1 text-sm">
                      {data.recipients.map((r) => (
                        <li key={r.email} className="flex items-center gap-2">
                          <span>{r.name}</span>
                          <span className="text-muted-foreground">
                            {r.email}
                          </span>
                          {r.outside && (
                            <Badge variant="blocked">
                              Outside your organization
                            </Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                    {outside.length > 0 && (
                      <p
                        role="alert"
                        className="text-sm text-[var(--status-blocked-text)]"
                      >
                        {outside.length === 1
                          ? "1 attendee is"
                          : `${outside.length} attendees are`}{" "}
                        outside your organization&apos;s domains (
                        {data.domains.join(", ")}). They&apos;ll see the title,
                        time and details of this meeting.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm">
                    There are no other attendees to invite yet.
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => toggle.mutate(true)}
                    disabled={toggle.isPending || !data.recipients.length}
                  >
                    {toggle.isPending ? "Sending…" : "Send invitations"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={putAway}
                    disabled={toggle.isPending}
                  >
                    Not now
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
