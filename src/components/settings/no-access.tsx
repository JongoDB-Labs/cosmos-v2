import { Lock } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/** Standard "you can't view this org-wide settings page" state. */
export function NoAccess({ what = "this page" }: { what?: string }) {
  return (
    <EmptyState
      icon={Lock}
      title="You don't have access"
      description={`You don't have permission to view ${what}. Ask an organization admin if you need it.`}
    />
  );
}
