"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";

/**
 * COSMOS-202: connect your own Outlook / Microsoft 365 calendar (B1), and
 * your Cosmos meetings are mirrored into it with Outlook edits brought back
 * (B2). Off until an org admin installs the Outlook Calendar integration.
 *
 * What a mirrored event carries follows a sharing level, as a calendar app's
 * own sharing does: full details, or free/busy only. Each person picks theirs
 * here; an admin sets the org-wide default on Integrations.
 */

type SharingLevel = "full" | "busy";

interface CalendarStatus {
  enabled: boolean;
  canManage: boolean;
  admin: { redirectUri: string; adminConsentUrl: string | null; appConfigured: boolean } | null;
  sharing?: { level: SharingLevel | "default"; orgDefault: SharingLevel; effective: SharingLevel };
  connection: {
    account: string;
    status: "connected" | "reconnect";
    connectedAt: string;
    lastSyncAt: string | null;
  } | null;
}

const LEVEL_LABELS: Record<SharingLevel, string> = {
  full: "Full details",
  busy: "Free/busy only",
};

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
  const setLevel = useOrgMutation({
    mutationFn: (level: SharingLevel | "default") =>
      jsonFetch<{ resyncNow: boolean }>(`/api/v1/orgs/${orgId}/microsoft/calendar/sharing`, {
        method: "PUT",
        body: JSON.stringify({ level }),
      }),
    invalidate: [["outlook-calendar"]],
    // Saved either way; only how soon Outlook catches up differs (the resync
    // shares "Sync now"'s budget), so say which happened rather than imply one.
    onSuccess: (r) =>
      toast.success(
        r?.resyncNow
          ? "Saved. Your Cosmos calendar is being updated."
          : "Saved. Your Cosmos calendar will catch up within a few minutes.",
      ),
    onError: (e) => notifyError(e, "Couldn't change that."),
  });
  const connectHref = `/api/v1/orgs/${orgId}/microsoft/calendar/connect`;
  const conn = data?.connection;
  const sharing = data?.sharing;

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
          {sharing && (
            <div className="space-y-1.5">
              <label htmlFor="outlook-sharing-level" className="text-sm font-medium">
                What your Cosmos calendar shows
              </label>
              <Select
                value={sharing.level}
                onValueChange={(v) => v && setLevel.mutate(v as SharingLevel | "default")}
                disabled={setLevel.isPending}
              >
                <SelectTrigger id="outlook-sharing-level" aria-label="What your Cosmos calendar shows" className="max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Organization default ({LEVEL_LABELS[sharing.orgDefault].toLowerCase()})</SelectItem>
                  <SelectItem value="full">{LEVEL_LABELS.full}</SelectItem>
                  <SelectItem value="busy">{LEVEL_LABELS.busy}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {sharing.effective === "busy"
                  ? "Your events go out as plain busy blocks: no titles, details or links. One exception — a meeting whose Outlook invitations you send yourself is a real Outlook event in this calendar, so it keeps its title, details and links, and anyone you share the calendar with can see them."
                  : "Your events carry their title, a link back to Cosmos, and the join link. Anyone you share your Outlook calendar with sees what your sharing permissions let them see, so pick free/busy only if that is wider than the meetings."}
              </p>
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

/** For admins, on Integrations: what the Entra app needs, in order, and the org-wide default. */
export function OutlookCalendarAdminSetup({ orgId }: { orgId: string }) {
  const { data } = useCalendarStatus(orgId);
  const consent = useLandingParam("msConsent");
  const setOrgDefault = useOrgMutation({
    mutationFn: (orgDefault: SharingLevel) =>
      jsonFetch(`/api/v1/orgs/${orgId}/microsoft/calendar/sharing`, { method: "PUT", body: JSON.stringify({ orgDefault }) }),
    invalidate: [["outlook-calendar"]],
    onSuccess: () => toast.success("Default saved"),
    onError: (e) => notifyError(e, "Couldn't change the default."),
  });
  if (!data?.canManage || !data.admin) return null;
  const a = data.admin;
  const sharing = data.sharing;
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
      {sharing && (
        <div className="mt-4 space-y-1.5 border-t border-border pt-4">
          <label htmlFor="outlook-sharing-default" className="text-sm font-medium">
            What published calendars show by default
          </label>
          <Select
            value={sharing.orgDefault}
            onValueChange={(v) => v && setOrgDefault.mutate(v as SharingLevel)}
            disabled={setOrgDefault.isPending}
          >
            <SelectTrigger id="outlook-sharing-default" aria-label="What published calendars show by default" className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="full">{LEVEL_LABELS.full}</SelectItem>
              <SelectItem value="busy">{LEVEL_LABELS.busy}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            What Cosmos writes into the calendar of anyone who hasn&apos;t chosen for themselves. Free/busy only
            sends plain busy blocks, with no titles, details or links — safest where people share their Outlook
            calendars widely. Each person can still choose their own under Settings, Preferences. A new default
            reaches everyone&apos;s calendar within a few minutes. Classified meetings are always busy only. A
            meeting whose Outlook invitations someone sends themselves still carries its details either way, since
            that invitation is their own Outlook event.
          </p>
        </div>
      )}
    </SectionCard>
  );
}
