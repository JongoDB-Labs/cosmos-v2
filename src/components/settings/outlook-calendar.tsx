"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { cn } from "@/lib/utils";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";

/**
 * COSMOS-202: connect your own Outlook / Microsoft 365 calendar (B1), and
 * your Cosmos meetings are mirrored into it with Outlook edits brought back
 * (B2). Off until an org admin installs the Outlook Calendar integration.
 */

interface CalendarStatus {
  enabled: boolean;
  canManage: boolean;
  admin: { redirectUri: string; adminConsentUrl: string | null; appConfigured: boolean } | null;
  connection: {
    account: string;
    status: "connected" | "reconnect";
    connectedAt: string;
    lastSyncAt: string | null;
  } | null;
}

/** What the callback came back with (?outlook=…), in words. */
const OUTCOMES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Outlook Calendar connected." },
  denied: { ok: false, text: "You didn't allow access in Microsoft, so nothing was connected." },
  wrong_tenant: { ok: false, text: "That Microsoft account belongs to a different organization. Use your work account." },
  invalid_state: { ok: false, text: "That sign-in link expired or didn't match. Try connecting again." },
  not_enabled: { ok: false, text: "Your organization hasn't turned on Outlook Calendar." },
  rate_limited: { ok: false, text: "Too many attempts. Wait a minute and try again." },
  failed: { ok: false, text: "Microsoft didn't complete the connection. Try again." },
};

/**
 * A one-off query value the connect round trip lands with. Read after mount,
 * not through useSearchParams, so the settings pages need no new Suspense
 * boundary (Cache Components is on).
 */
function useLandingParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(new URLSearchParams(window.location.search).get(name));
  }, [name]);
  return value;
}

function useCalendarStatus(orgId: string) {
  return useQuery({
    queryKey: useOrgQueryKey("outlook-calendar"),
    queryFn: () => jsonFetch<CalendarStatus>(`/api/v1/orgs/${orgId}/microsoft/calendar`),
  });
}

/** For everyone, on Preferences. */
export function OutlookCalendarSection({ orgId }: { orgId: string }) {
  const { data } = useCalendarStatus(orgId);
  const outcome = OUTCOMES[useLandingParam("outlook") ?? ""];
  // Set when the server asks what happens to invitations this person sent.
  const [liveInvites, setLiveInvites] = useState<number | null>(null);
  // The button used is replaced or disabled at each step, so focus is moved on
  // purpose: into the choice when it appears, back to Disconnect if it's put
  // away, and to Connect once disconnected.
  const [focusTo, setFocusTo] = useState<"choice" | "disconnect" | "connect" | null>(null);
  const choiceRef = useRef<HTMLDivElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const connectRef = useRef<HTMLAnchorElement>(null);
  const disconnect = useOrgMutation({
    mutationFn: (invites?: "keep" | "cancel") =>
      jsonFetch(`/api/v1/orgs/${orgId}/microsoft/calendar${invites ? `?invites=${invites}` : ""}`, { method: "DELETE" }),
    invalidate: [["outlook-calendar"]],
    onSuccess: () => {
      setLiveInvites(null);
      setFocusTo("connect");
      toast.success("Outlook Calendar disconnected");
    },
    onError: (e) => {
      const live = e instanceof FetchError && e.status === 409 ? (e.body as { liveInvites?: number } | null)?.liveInvites : undefined;
      if (typeof live === "number") {
        setLiveInvites(live);
        setFocusTo("choice");
      } else notifyError(e, "Couldn't disconnect.");
    },
  });
  useEffect(() => {
    if (!focusTo) return;
    const el = { choice: choiceRef, disconnect: disconnectRef, connect: connectRef }[focusTo].current;
    if (!el) return; // not rendered yet (the refetch after disconnecting): next render
    el.focus();
    setFocusTo(null);
  }, [focusTo, data, liveInvites]);
  const syncNow = useOrgMutation({
    mutationFn: () => jsonFetch(`/api/v1/orgs/${orgId}/microsoft/calendar/sync`, { method: "POST" }),
    invalidate: [["outlook-calendar"]],
    onSuccess: () => toast.success("Outlook Calendar synced"),
    onError: (e) => notifyError(e, "Couldn't sync."),
  });
  const connectHref = `/api/v1/orgs/${orgId}/microsoft/calendar/connect`;
  const conn = data?.connection;

  return (
    <SectionCard
      icon={CalendarCheck}
      title="Outlook calendar"
      description="Connect your Microsoft 365 calendar, so your Cosmos meetings appear in Outlook."
    >
      {outcome && (
        <p role={outcome.ok ? "status" : "alert"} className={cn("mb-3 text-sm", !outcome.ok && "text-[var(--status-critical-text)]")}>
          {outcome.text}
        </p>
      )}
      {!data ? null : !data.enabled ? (
        <p className="text-sm text-muted-foreground">
          Your organization hasn&apos;t turned on Outlook Calendar.
          {data.canManage && " You can turn it on under Settings, Integrations."}
        </p>
      ) : !conn ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            You&apos;ll sign in with your work Microsoft account and allow calendar access only. Cosmos writes
            to a separate &quot;Cosmos&quot; calendar it creates, never your main one.
          </p>
          <div>
            <a ref={connectRef} href={connectHref} className={cn(buttonVariants({ size: "sm" }))}>
              Connect Outlook Calendar
            </a>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {conn.status === "reconnect" ? (
            <p role="alert" className="text-sm text-[var(--status-critical-text)]">
              Microsoft stopped accepting this connection (the access was withdrawn or expired). Reconnect to
              keep syncing.
            </p>
          ) : (
            <p className="text-sm">
              Connected as <strong>{conn.account}</strong> since {new Date(conn.connectedAt).toLocaleDateString()}.
              {" "}
              {conn.lastSyncAt ? `Last synced ${new Date(conn.lastSyncAt).toLocaleString()}.` : "Not synced yet."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {conn.status === "reconnect" && (
              <a href={connectHref} className={cn(buttonVariants({ size: "sm" }))}>
                Reconnect
              </a>
            )}
            {conn.status === "connected" && (
              <Button size="sm" onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
                {syncNow.isPending ? "Syncing…" : "Sync now"}
              </Button>
            )}
            <Button ref={disconnectRef} variant="outline" size="sm" onClick={() => disconnect.mutate(undefined)} disabled={disconnect.isPending || liveInvites !== null}>
              Disconnect
            </Button>
          </div>
          {liveInvites !== null && (
            <div ref={choiceRef} tabIndex={-1} role="group" aria-label="Your Outlook invitations" className="flex flex-col gap-2 rounded-md border p-3 outline-none">
              <p className="text-sm">
                You sent Outlook invitations for {liveInvites === 1 ? "1 upcoming meeting" : `${liveInvites} upcoming meetings`}.
                What should happen to them?
              </p>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                <li>Cancel: attendees get a cancellation in Outlook, and the meetings go back to their Cosmos calendars.</li>
                <li>
                  Keep: the invitations stay in Outlook, but Cosmos will no longer update them. Changes made in
                  Cosmos won&apos;t reach the attendees, and you&apos;ll have to update or cancel them in Outlook yourself.
                </li>
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="destructive" onClick={() => disconnect.mutate("cancel")} disabled={disconnect.isPending}>
                  Cancel invitations and disconnect
                </Button>
                <Button size="sm" variant="outline" onClick={() => disconnect.mutate("keep")} disabled={disconnect.isPending}>
                  Keep invitations and disconnect
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setLiveInvites(null);
                    setFocusTo("disconnect");
                  }}
                  disabled={disconnect.isPending}
                >
                  Don&apos;t disconnect
                </Button>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Meetings you attend appear in your &quot;Cosmos&quot; calendar. A time or title change you make there
            comes back to Cosmos if you can edit that meeting; otherwise the Cosmos version is put back. Deleting
            the event in Outlook only removes your copy. Classified meetings show only as busy.
          </p>
          <p className="text-xs text-muted-foreground">
            Disconnecting removes the &quot;Cosmos&quot; calendar from your Outlook and deletes the access Cosmos holds.
            To remove the app from your Microsoft account too, go to myapps.microsoft.com.
          </p>
        </div>
      )}
    </SectionCard>
  );
}

/** For admins, on Integrations: what the Entra app needs, in order. */
export function OutlookCalendarAdminSetup({ orgId }: { orgId: string }) {
  const { data } = useCalendarStatus(orgId);
  const consent = useLandingParam("msConsent");
  if (!data?.canManage || !data.admin) return null;
  const a = data.admin;
  const copy = (v: string) =>
    void navigator.clipboard?.writeText(v).then(
      () => toast.success("Copied"),
      () => toast.error("Couldn't copy; select it and copy it."),
    );
  return (
    <SectionCard
      icon={CalendarCheck}
      title="Outlook Calendar setup"
      description="Lets people connect their own Microsoft 365 calendars. Off until you install the Outlook Calendar integration below."
    >
      {consent && (
        <p role={consent === "granted" ? "status" : "alert"} className={cn("mb-3 text-sm", consent !== "granted" && "text-[var(--status-critical-text)]")}>
          {consent === "granted" ? "Microsoft admin consent granted." : "Microsoft admin consent wasn't granted."}
        </p>
      )}
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          {a.appConfigured
            ? "The Microsoft sign-in app is configured."
            : "Configure the Microsoft sign-in app first (Admin, Sign-in providers)."}
        </li>
        <li>
          In the Entra app registration, add this redirect URI:
          <span className="mt-1 flex items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.redirectUri}</code>
            <Button variant="ghost" size="sm" aria-label="Copy redirect URI" onClick={() => copy(a.redirectUri)}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </span>
        </li>
        <li>Under API permissions, add the delegated Microsoft Graph permission Calendars.ReadWrite.</li>
        <li>Install &quot;Outlook Calendar&quot; below with your Directory (tenant) ID.</li>
        <li>
          {a.adminConsentUrl ? (
            <>
              A Microsoft admin grants consent once for everyone:{" "}
              <a href={a.adminConsentUrl} className="underline">
                Grant admin consent
              </a>
            </>
          ) : (
            "Then grant admin consent once (the link appears here after step 4)."
          )}
        </li>
      </ol>
    </SectionCard>
  );
}
