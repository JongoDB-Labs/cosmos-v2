import { Lock } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * What a page renders instead of its contents when the actor is not entitled
 * to it.
 *
 * Deliberately NOT `notFound()`. These pages exist for the organisation and
 * their colleagues use them — pretending otherwise turns "ask an admin for
 * access" into "report a broken link". Nothing is leaked by admitting the page
 * exists: the sidebar already shows the section to anyone entitled, and the
 * only secret is the DATA, which never loads.
 *
 * Matches the shape the Activity page has always used, so denial looks the same
 * wherever it happens rather than being reinvented per screen.
 */
export function NoPageAccess({ what }: { what: string }) {
  return (
    <EmptyState
      illustration={
        <Lock
          className="mx-auto h-12 w-12 text-[var(--text-muted)]"
          strokeWidth={1.5}
          aria-hidden
        />
      }
      title={`No access to ${what}`}
      description={`You don't have permission to view ${what} in this organization. An organization admin can grant it.`}
    />
  );
}
