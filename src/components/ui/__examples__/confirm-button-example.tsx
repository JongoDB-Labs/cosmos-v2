"use client";
import { useState } from "react";
import { ConfirmButton } from "../confirm-button";
import { ToggleSwitch } from "../toggle-switch";

export function ConfirmButtonBasic() {
  const [deletes, setDeletes] = useState(0);
  return (
    <div className="flex items-center gap-3 text-sm">
      <ConfirmButton onConfirm={() => setDeletes((n) => n + 1)}>
        Delete project
      </ConfirmButton>
      <span className="text-[var(--text-muted)]">
        {deletes === 0
          ? "Click, then confirm"
          : `Confirmed ${deletes} time${deletes === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}

export function ConfirmButtonVariants() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ConfirmButton
        variant="outline"
        size="sm"
        confirmLabel="Yes, disconnect"
        onConfirm={() => {}}
      >
        Disconnect
      </ConfirmButton>
      <ConfirmButton disabled onConfirm={() => {}}>
        Delete (disabled)
      </ConfirmButton>
    </div>
  );
}

export function ConfirmButtonPending() {
  // `pending` reflects an external in-flight action. Its spinner shows on the
  // confirm button only while the button is armed, so flip this on first, then
  // arm the button to see the loading state.
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <ConfirmButton
        confirmLabel="Revoke key"
        pending={pending}
        onConfirm={() => {}}
      >
        Revoke API key
      </ConfirmButton>
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <ToggleSwitch
          checked={pending}
          onCheckedChange={setPending}
          aria-label="Simulate request in flight"
        />
        <span>Turn on, then arm the button to see the in-flight spinner</span>
      </div>
    </div>
  );
}
