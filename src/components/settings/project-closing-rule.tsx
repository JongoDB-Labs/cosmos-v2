"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * This project's choice for the closing rule (src/lib/workflow/closing-rule.ts):
 * follow the organization, or turn it on or off for this project alone.
 */
export function ProjectClosingRule({
  orgId,
  projectId,
  value,
  canUpdate,
}: {
  orgId: string;
  projectId: string;
  /** null = follow the organization's setting. */
  value: boolean | null;
  canUpdate: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<"org" | "on" | "off">(value === null ? "org" : value ? "on" : "off");
  const [saving, setSaving] = useState(false);

  async function change(next: "org" | "on" | "off") {
    const prev = current;
    setCurrent(next);
    setSaving(true);
    try {
      // settings merges server-side; null removes the project's own choice.
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { closingRule: next === "org" ? null : next === "on" } }),
      });
      if (!res.ok) throw new Error("Failed");
      router.refresh();
    } catch {
      setCurrent(prev);
      toast.error("Couldn't change the closing rule");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 border-t px-4 py-3">
      <div className="min-w-0">
        <label htmlFor="project-closing-rule" className="text-sm font-medium">
          Closing rule
        </label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Items need a supporting file, or a recorded reason one isn&apos;t needed, to move to Done, and are
          read-only once closed until reopened.
        </p>
      </div>
      <select
        id="project-closing-rule"
        className="h-9 rounded-md border bg-background px-2 text-sm"
        value={current}
        disabled={!canUpdate || saving}
        onChange={(e) => void change(e.target.value as "org" | "on" | "off")}
      >
        <option value="org">Follow the organization</option>
        <option value="on">On for this project</option>
        <option value="off">Off for this project</option>
      </select>
    </div>
  );
}
