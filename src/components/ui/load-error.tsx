import { AlertTriangle } from "lucide-react";
import { EmptyState } from "./empty-state";
import { Button } from "./button";

export interface LoadErrorProps {
  /** Called when the user clicks "Try again" — re-run the failed load (e.g. a
   * React Query `refetch`, or the view's load function). */
  onRetry?: () => void;
  title?: string;
  description?: string;
}

/**
 * Shown in place of content when a data load FAILS (distinct from EmptyState,
 * which means "loaded fine, but there's nothing here"). Gives the user a clear
 * signal + a way to retry instead of a stuck skeleton or a misleading "empty".
 */
export function LoadError({
  onRetry,
  title = "Couldn't load this",
  description = "Something went wrong while loading. Check your connection and try again.",
}: LoadErrorProps) {
  return (
    <EmptyState
      title={title}
      description={description}
      illustration={
        <AlertTriangle
          className="mx-auto h-12 w-12 text-[var(--status-blocked-text,var(--status-blocked))]"
          strokeWidth={1.5}
          aria-hidden
        />
      }
      action={
        onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}
