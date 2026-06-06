"use client";
import { useState } from "react";
import { Checkbox } from "../checkbox";

export function CheckboxBasic() {
  const [checked, setChecked] = useState(true);
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <Checkbox
        checked={checked}
        onChange={(e) => setChecked(e.target.checked)}
        aria-label="Enable notifications"
      />
      Enable notifications
    </label>
  );
}

export function CheckboxIndeterminate() {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <label className="inline-flex items-center gap-2">
        <Checkbox indeterminate readOnly aria-label="Select all" />
        Select all
      </label>
      <label className="inline-flex items-center gap-2 pl-6">
        <Checkbox checked readOnly aria-label="Item one" />
        Item one
      </label>
      <label className="inline-flex items-center gap-2 pl-6 text-[var(--text-muted)]">
        <Checkbox disabled aria-label="Item two (disabled)" />
        Item two (disabled)
      </label>
    </div>
  );
}
