"use client";

/**
 * Subscribe to a saved filter by email (query design §12.4): who gets it (you,
 * or a team you're on and manage), when (a preset or a cron, in your time
 * zone), what (the list or just the count), only new items, and whether to
 * send when nothing matches. Lists the subscriptions you can manage, to pause,
 * resume or remove.
 *
 * Each recipient's email is built from what THEY can see, so subscribing a
 * team never shows anyone a row they couldn't open.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { checkSchedule, describeSchedule, presetCron, type Preset } from "@/lib/query/schedule";
import { apiErrorText, type SavedFilter } from "./use-saved-filters";

interface Subscription {
  id: string;
  createdById: string;
  cron: string;
  timezone: string;
  format: "LIST" | "COUNT";
  sendWhenEmpty: boolean;
  onlyChanges: boolean;
  nextRunAt: string;
  disabledAt: string | null;
  disabledReason: string | null;
  lastError: string | null;
  recipientUser: { id: string; displayName: string } | null;
  recipientTeam: { id: string; name: string } | null;
}

const PRESETS: { value: Preset; label: string }[] = [
  { value: "weekdays", label: "Weekdays" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Once a week" },
  { value: "monthly", label: "Once a month" },
  { value: "custom", label: "Custom (cron)" },
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export function SubscribeDialog({
  orgId,
  filter,
  open,
  onOpenChange,
}: {
  orgId: string;
  filter: SavedFilter | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return open && filter ? <SubscribeForm key={filter.id} orgId={orgId} filter={filter} open={open} onOpenChange={onOpenChange} /> : <Dialog open={false} />;
}

function SubscribeForm({ orgId, filter, open, onOpenChange }: { orgId: string; filter: SavedFilter; open: boolean; onOpenChange: (o: boolean) => void }) {
  const base = `/api/v1/orgs/${orgId}/saved-views/${filter.id}/subscriptions`;
  const list = useQuery({
    queryKey: useOrgQueryKey("filter-subscriptions", filter.id),
    queryFn: () => jsonFetch<{ subscriptions: Subscription[]; teams: { id: string; name: string }[] }>(base),
  });
  const invalidate = [["filter-subscriptions", filter.id]];
  const create = useOrgMutation({ mutationFn: (body: unknown) => jsonFetch(base, { method: "POST", body: JSON.stringify(body) }), invalidate });
  const patch = useOrgMutation({
    mutationFn: ({ id, ...body }: { id: string; enabled: boolean }) => jsonFetch(`${base}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    invalidate,
    onError: (e) => toast.error(apiErrorText(e, "Couldn't change the subscription.")),
  });
  const remove = useOrgMutation({
    mutationFn: (id: string) => jsonFetch(`${base}/${id}`, { method: "DELETE" }),
    invalidate,
    onError: (e) => toast.error(apiErrorText(e, "Couldn't remove the subscription.")),
  });

  const [recipient, setRecipient] = useState<string>("me");
  const [preset, setPreset] = useState<Preset>("weekdays");
  const [time, setTime] = useState("08:00");
  const [weekday, setWeekday] = useState(1);
  const [monthDay, setMonthDay] = useState(1);
  const [custom, setCustom] = useState("0 8 * * 1-5");
  const [format, setFormat] = useState<"LIST" | "COUNT">("LIST");
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [sendWhenEmpty, setSendWhenEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timezone = useMemo(() => browserZone(), []);

  const cron = presetCron(preset, time, weekday, monthDay, custom);
  const check = useMemo(() => checkSchedule(cron, timezone), [cron, timezone]);

  async function subscribe() {
    if ("error" in check) return setError(check.error);
    setError(null);
    try {
      await create.mutateAsync({
        recipient: recipient === "me" ? { kind: "me" } : { kind: "team", teamId: recipient },
        cron,
        timezone,
        format,
        onlyChanges,
        sendWhenEmpty,
      });
      toast.success(`Subscribed to "${filter.name}"`);
    } catch (e) {
      setError(apiErrorText(e, "Couldn't subscribe."));
    }
  }

  const subs = list.data?.subscriptions ?? [];
  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Subscribe to “{filter.name}”</DialogTitle>
          <DialogDescription>Get this filter by email on a schedule. Everyone gets only the items they can open.</DialogDescription>
        </DialogHeader>

        {subs.length > 0 && (
          <ul aria-label="Subscriptions" className="space-y-2 rounded-md border border-[var(--border)] p-2 text-sm">
            {subs.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium">{s.recipientTeam ? `Team ${s.recipientTeam.name}` : (s.recipientUser?.displayName ?? "Removed")}</span>
                  {" · "}
                  {describeSchedule(s.cron)} ({s.timezone})
                  <span className="block text-xs text-[var(--text-muted)]">
                    {s.disabledAt ? `Off: ${s.disabledReason ?? "paused"}` : `Next: ${new Date(s.nextRunAt).toLocaleString()}`}
                    {s.lastError ? ` · Last run: ${s.lastError}` : ""}
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => patch.mutate({ id: s.id, enabled: !!s.disabledAt })}>
                    {s.disabledAt ? "Resume" : "Pause"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)} aria-label={`Remove subscription for ${s.recipientTeam?.name ?? s.recipientUser?.displayName ?? "removed"}`}>
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void subscribe();
          }}
        >
          <div className="space-y-1">
            <Label>Send to</Label>
            <SearchableSelect
              value={recipient}
              onValueChange={(v) => setRecipient(v ?? "me")}
              options={[{ value: "me", label: "Me" }, ...(list.data?.teams ?? []).map((t) => ({ value: t.id, label: `Team ${t.name}` }))]}
              aria-label="Send to"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>When</Label>
              <SearchableSelect value={preset} onValueChange={(v) => setPreset((v as Preset) ?? "weekdays")} options={PRESETS} aria-label="When" />
            </div>
            {preset !== "custom" ? (
              <div className="space-y-1">
                <Label htmlFor="sub-time">At</Label>
                <Input id="sub-time" type="time" step={60} value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            ) : (
              <div className="space-y-1">
                <Label htmlFor="sub-cron">Cron</Label>
                <Input id="sub-cron" value={custom} onChange={(e) => setCustom(e.target.value)} className="font-mono" spellCheck={false} />
              </div>
            )}
          </div>
          {preset === "weekly" && (
            <SearchableSelect
              value={String(weekday)}
              onValueChange={(v) => setWeekday(Number(v ?? 1))}
              options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
              aria-label="Day of the week"
            />
          )}
          {preset === "monthly" && (
            <SearchableSelect
              value={String(monthDay)}
              onValueChange={(v) => setMonthDay(Number(v ?? 1))}
              options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `Day ${i + 1}` }))}
              aria-label="Day of the month"
            />
          )}
          <p className="text-xs text-[var(--text-muted)]" aria-live="polite">
            {"error" in check ? check.error : `Next: ${check.next.toLocaleString()} (${timezone})`}
          </p>
          <div className="space-y-1">
            <Label>Email shows</Label>
            <SearchableSelect
              value={format}
              onValueChange={(v) => setFormat((v as "LIST" | "COUNT") ?? "LIST")}
              options={[
                { value: "LIST", label: "The items (up to 50)" },
                { value: "COUNT", label: "Just the count" },
              ]}
              aria-label="Email shows"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
            Only items that are new since the last email
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sendWhenEmpty} onChange={(e) => setSendWhenEmpty(e.target.checked)} />
            Send even when nothing matches
          </label>
          {error && (
            <p role="alert" className="text-sm text-[var(--status-blocked-text)]">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Subscribing…" : "Subscribe"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
