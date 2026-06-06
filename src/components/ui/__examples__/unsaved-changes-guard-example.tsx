"use client";
import { UnsavedChangesGuard } from "../unsaved-changes-guard";

/**
 * Rendered with `dirty={false}` on purpose: when dirty, the guard installs a
 * global document click-capture listener that intercepts every same-origin
 * anchor navigation to pop its confirm dialog. Mounting it "armed" in the
 * gallery would hijack the page's own links, so this demo shows it inert and
 * documents the API in the code panel instead.
 */
export function UnsavedChangesGuardDemo() {
  return (
    <div className="text-sm text-[var(--text-muted)]">
      <UnsavedChangesGuard
        dirty={false}
        onSave={async () => true}
        onDiscard={() => {}}
      />
      <p>
        Mount this near a form. While <code>dirty</code> is true it intercepts
        in-app navigation and <code>beforeunload</code>, prompting
        Save&nbsp;/&nbsp;Discard&nbsp;/&nbsp;Stay before the user leaves.
      </p>
    </div>
  );
}
