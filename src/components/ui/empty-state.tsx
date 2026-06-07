import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  /**
   * Contextual lucide icon for the module (e.g. FolderKanban for projects,
   * Package for products). Rendered in a tasteful rounded tile. Defaults to a
   * neutral inbox so an empty state never looks unfinished.
   */
  icon?: LucideIcon;
  /** Full custom illustration — takes precedence over `icon` when provided. */
  illustration?: React.ReactNode;
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
  illustration,
}: EmptyStateProps) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      {illustration ? (
        <div className="mb-4 w-24 opacity-90">{illustration}</div>
      ) : (
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] shadow-sm">
          <Icon className="h-6 w-6" strokeWidth={1.5} aria-hidden />
        </div>
      )}
      <h3 className="text-base font-semibold text-[var(--text)]">{title}</h3>
      {description && (
        <p className="mt-2 text-sm text-[var(--text-muted)]">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
