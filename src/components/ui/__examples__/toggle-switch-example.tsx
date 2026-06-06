"use client";
import { useState } from "react";
import { ToggleSwitch } from "../toggle-switch";

export function ToggleSwitchBasic() {
  const [on, setOn] = useState(true);
  return (
    <div className="flex items-center gap-3 text-sm">
      <ToggleSwitch
        checked={on}
        onCheckedChange={setOn}
        aria-label="Enable webhooks"
      />
      <span className="text-[var(--text-muted)]">
        Webhooks {on ? "enabled" : "disabled"}
      </span>
    </div>
  );
}

export function ToggleSwitchStates() {
  return (
    <div className="flex items-center gap-4">
      <ToggleSwitch checked onCheckedChange={() => {}} aria-label="On" />
      <ToggleSwitch checked={false} onCheckedChange={() => {}} aria-label="Off" />
      <ToggleSwitch
        checked
        disabled
        onCheckedChange={() => {}}
        aria-label="On, disabled"
      />
    </div>
  );
}
