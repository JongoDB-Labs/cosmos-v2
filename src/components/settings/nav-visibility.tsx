"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";
import { UNHIDEABLE_NAV_IDS } from "@/lib/nav/nav-layout";

export interface NavSection {
  id: string;
  label: string;
}

/**
 * Which sections this organisation shows in its sidebar.
 *
 * Whole-org, not per person: the practice decides once what its people see, so
 * nobody is quietly looking at a different product from the person beside them.
 *
 * Only the sections a user could ALREADY reach are listed — permission and
 * plugin filtering run before this in the sidebar, so hiding can take something
 * away and can never hand anything out.
 */
export function NavVisibility({
  orgId,
  sections,
  initialHidden,
}: {
  orgId: string;
  sections: NavSection[];
  initialHidden: string[];
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set(initialHidden));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    hidden.size !== initialHidden.length ||
    initialHidden.some((id) => !hidden.has(id));

  function toggle(id: string) {
    setSaved(false);
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/nav-layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: [...hidden] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not save");
        return;
      }
      setSaved(true);
    } catch {
      setError("Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-[var(--border)] rounded border border-[var(--border)]">
        {sections.map((s) => {
          const locked = (UNHIDEABLE_NAV_IDS as readonly string[]).includes(s.id);
          const shown = !hidden.has(s.id);
          return (
            <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="flex items-center gap-2">
                {shown ? (
                  <Eye className="size-4 text-[var(--text-muted)]" />
                ) : (
                  <EyeOff className="size-4 text-[var(--text-muted)]" />
                )}
                <span className={cn("text-sm", !shown && "text-[var(--text-muted)]")}>
                  {s.label}
                </span>
                {locked && (
                  <span className="text-xs text-[var(--text-muted)]">
                    — always shown, so there is always a way back
                  </span>
                )}
              </span>
              <ToggleSwitch
                checked={shown}
                disabled={locked || saving}
                onCheckedChange={() => toggle(s.id)}
                aria-label={`Show ${s.label} in the sidebar`}
              />
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {saved && !dirty && (
          <span className="text-sm text-[var(--text-muted)]">
            Saved — reload to see the sidebar change.
          </span>
        )}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
