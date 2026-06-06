"use client";
import { useEffect, useState } from "react";
import { notifyError } from "@/lib/errors/notify";

type Prefs = {
  dndEnabled: boolean;
  dndStart: string;
  dndEnd: string;
  dndTimezone: string;
};

const COMMON_TZ = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export function DndSettings({ orgId }: { orgId: string }) {
  const [prefs, setPrefs] = useState<Prefs>({
    dndEnabled: false,
    dndStart: "22:00",
    dndEnd: "07:00",
    dndTimezone:
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : "UTC",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/v1/orgs/${orgId}/preferences`);
        if (!r.ok) return;
        const j = await r.json();
        const data = j.data ?? j;
        if (cancelled) return;
        setPrefs((p) => ({
          dndEnabled: data.dndEnabled ?? p.dndEnabled,
          dndStart: data.dndStart ?? p.dndStart,
          dndEnd: data.dndEnd ?? p.dndEnd,
          dndTimezone: data.dndTimezone ?? p.dndTimezone,
        }));
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  async function save(next: Prefs) {
    const prev = prefs;
    setPrefs(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/preferences`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error("Failed to save DND settings:", err);
      setPrefs(prev);
      notifyError(err, "Couldn't save your Do-Not-Disturb settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={prefs.dndEnabled}
          onChange={(e) => save({ ...prefs, dndEnabled: e.target.checked })}
        />
        Do Not Disturb — suppress push notifications during quiet hours
      </label>
      {prefs.dndEnabled && (
        <div className="flex flex-wrap items-center gap-2 text-sm pl-6">
          <label className="flex items-center gap-1">
            From
            <input
              type="time"
              value={prefs.dndStart}
              onChange={(e) => save({ ...prefs, dndStart: e.target.value })}
              className="border rounded px-1 py-0.5"
            />
          </label>
          <label className="flex items-center gap-1">
            to
            <input
              type="time"
              value={prefs.dndEnd}
              onChange={(e) => save({ ...prefs, dndEnd: e.target.value })}
              className="border rounded px-1 py-0.5"
            />
          </label>
          <label className="flex items-center gap-1">
            tz
            <select
              value={prefs.dndTimezone}
              onChange={(e) => save({ ...prefs, dndTimezone: e.target.value })}
              className="border rounded px-1 py-0.5"
            >
              {COMMON_TZ.includes(prefs.dndTimezone) ? null : (
                <option value={prefs.dndTimezone}>{prefs.dndTimezone}</option>
              )}
              {COMMON_TZ.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
          {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
        </div>
      )}
    </div>
  );
}
